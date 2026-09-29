"use client";

import { useEffect, useRef, useState } from "react";
import type { FocusEvent, InputHTMLAttributes, KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import type * as ZXingBrowser from "@zxing/browser";
import type { MessageKey } from "@/i18n/messages";

export type ScanKind = "order" | "location" | "sku";
type Translator = (key: MessageKey, values?: Record<string, string>) => string;

/** Normalize scanner payloads to the value expected by the field/server. */
export function normalizeScannedValue(raw: string, kind: ScanKind): string {
  const trimmed = raw.trim();
  if (kind === "order") {
    const runs = trimmed.match(/\d+/g);
    // Multiple numeric runs need explicit correction rather than silent guessing.
    if (!runs || runs.length !== 1) return trimmed;
    return runs[0] ?? trimmed;
  }
  return trimmed.toUpperCase();
}

type DetectedBarcode = { rawValue: string };
type BarcodeDetectorInstance = { detect(source: ImageBitmapSource | Blob | ImageData): Promise<DetectedBarcode[]> };
type BarcodeDetectorConstructor = new (options?: { formats?: string[] }) => BarcodeDetectorInstance;
type DecoderControls = { stop(): void };
type ZxingModule = typeof ZXingBrowser;

declare global { interface Window { BarcodeDetector?: BarcodeDetectorConstructor } }

function detectorConstructor(): BarcodeDetectorConstructor | null {
  if (typeof window === "undefined") return null;
  const available = window.BarcodeDetector;
  return typeof available === "function" ? available : null;
}

let zxingPromise: Promise<ZxingModule> | null = null;
function loadZxing(): Promise<ZxingModule> {
  zxingPromise ??= import("@zxing/browser");
  return zxingPromise;
}

const SCAN_FORMATS = [
  "qr_code", "aztec", "data_matrix", "pdf417", "code_128", "code_39", "code_93",
  "codabar", "ean_13", "ean_8", "upc_a", "upc_e", "itf",
];

type ScanInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> & {
  value: string;
  onChange: (value: string) => void;
  onScannedExtra?: () => void;
  tr: Translator;
  scanKind: ScanKind;
  fieldLabel: string;
  type?: string;
};

export function ScanInput({ value, onChange, onScannedExtra, tr, scanKind, fieldLabel, id, onBlur, onKeyDown, ...inputProps }: ScanInputProps) {
  const [open, setOpen] = useState(false);
  const [supported, setSupported] = useState(false);
  const [error, setError] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const generationRef = useRef(0);
  const cleanupRef = useRef<() => void>(() => undefined);
  const onChangeRef = useRef(onChange);
  const extraRef = useRef(onScannedExtra);
  const kindRef = useRef(scanKind);
  const trRef = useRef(tr);

  useEffect(() => {
    onChangeRef.current = onChange;
    extraRef.current = onScannedExtra;
    kindRef.current = scanKind;
    trRef.current = tr;
  });

  const openScanner = () => {
    setError("");
    // The fallback is browser-only and is loaded after this user gesture.
    setSupported(true);
    setOpen(true);
  };

  const closeScanner = () => {
    generationRef.current += 1;
    cleanupRef.current();
    setOpen(false);
    setError("");
    inputRef.current?.focus();
  };

  const handleBlur = (event: FocusEvent<HTMLInputElement>) => {
    if (scanKind === "order") {
      const normalized = normalizeScannedValue(event.currentTarget.value, "order");
      if (normalized !== event.currentTarget.value) onChange(normalized);
    }
    onBlur?.(event);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && scanKind === "order") {
      const normalized = normalizeScannedValue(event.currentTarget.value, "order");
      if (normalized !== event.currentTarget.value) flushSync(() => onChange(normalized));
    }
    onKeyDown?.(event);
  };

  useEffect(() => {
    if (!open) return;
    const generation = ++generationRef.current;
    let stream: MediaStream | null = null;
    let controls: DecoderControls | void;
    let stopped = false;

    const stopResources = () => {
      if (stopped) return;
      stopped = true;
      controls?.stop();
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
    };
    cleanupRef.current = stopResources;

    const commit = (raw: string) => {
      if (stopped || generation !== generationRef.current) return;
      generationRef.current += 1;
      stopResources();
      onChangeRef.current(normalizeScannedValue(raw, kindRef.current));
      extraRef.current?.();
      setOpen(false);
      setError("");
    };

    const start = async () => {
      try {
        if (!window.navigator.mediaDevices?.getUserMedia) throw new Error("camera unavailable");
        const pendingStream = await window.navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        if (stopped || generation !== generationRef.current) {
          pendingStream.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = pendingStream;
        const video = videoRef.current;
        if (!video) throw new Error("video unavailable");
        video.srcObject = stream;
        await video.play();
        const ctor = detectorConstructor();
        if (ctor) {
          const detector = new ctor({ formats: SCAN_FORMATS });
          const tick = async () => {
            if (stopped || generation !== generationRef.current) return;
            try {
              const results = await detector.detect(video);
              const raw = results[0]?.rawValue;
              if (raw) { commit(raw); return; }
            } catch { /* A bad frame is retried. */ }
            if (!stopped && generation === generationRef.current) requestAnimationFrame(() => void tick());
          };
          void tick();
          return;
        }

        const { BrowserMultiFormatReader } = await loadZxing();
        if (stopped || generation !== generationRef.current) { stopResources(); return; }
        const reader = new BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts: 150 });
        controls = await reader.decodeFromVideoElement(video, (result) => {
          const raw = result?.getText();
          if (raw) commit(raw);
        });
        if (stopped || generation !== generationRef.current) controls?.stop();
      } catch {
        // Setup errors must release the camera immediately, not only on dialog close.
        const active = !stopped && generation === generationRef.current;
        stopResources();
        if (active) setError(trRef.current("scanCameraError"));
      }
    };
    void start();
    return () => {
      generationRef.current += 1;
      stopResources();
      if (cleanupRef.current === stopResources) cleanupRef.current = () => undefined;
    };
  }, [open]);

  const decodePhoto = async (file: File) => {
    const generation = generationRef.current;
    const url = URL.createObjectURL(file);
    try {
      let raw: string | undefined;
      const ctor = detectorConstructor();
      if (ctor) {
        const bitmap = await createImageBitmap(file);
        try { raw = (await new ctor({ formats: SCAN_FORMATS }).detect(bitmap))[0]?.rawValue; }
        finally { bitmap.close(); }
      } else {
        const { BrowserMultiFormatReader } = await loadZxing();
        raw = (await new BrowserMultiFormatReader().decodeFromImageUrl(url)).getText();
      }
      // Closing the dialog or accepting a camera result invalidates this photo.
      if (generation !== generationRef.current || !open) return;
      if (!raw) { setError(tr("scanPhotoError")); return; }
      // Invalidate every competing camera/photo completion before notifying the parent.
      generationRef.current += 1;
      cleanupRef.current();
      onChange(normalizeScannedValue(raw, scanKind));
      onScannedExtra?.();
      setOpen(false);
      setError("");
    } catch {
      if (generation === generationRef.current && open) setError(tr("scanPhotoError"));
    }
    finally {
      URL.revokeObjectURL(url);
    }
  };

  return (
    <>
      <div className="scan-field">
        <input ref={inputRef} id={id} value={value} onChange={(event) => onChange(event.target.value)} onBlur={handleBlur} onKeyDown={handleKeyDown} {...inputProps} />
        <button type="button" className="scan-button" aria-label={tr("scanButtonLabel", { field: fieldLabel })} title={tr("scanButtonLabel", { field: fieldLabel })} onClick={openScanner}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" /><path d="M4 12h16" /></svg>
        </button>
      </div>
      {open && (
        <div className="scan-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeScanner(); }}>
          <section className="scan-dialog" role="dialog" aria-modal="true" aria-label={tr("scanTitle")}>
            <h2>{tr("scanTitle")}</h2>
            <p>{tr("scanDescription")}</p>
            {!supported ? <p className="scan-alert" role="alert">{tr("scanNotSupported")}</p> : <>
              <video ref={videoRef} className="scan-video" muted playsInline autoPlay aria-label={tr("scanTitle")} />
              {error ? <p className="scan-alert" role="alert">{error}</p> : <p className="scan-waiting" aria-live="polite">{tr("scanWaiting")}</p>}
              <label className="scan-photo-label"><span>{tr("scanFromPhoto")}</span><input type="file" accept="image/*" capture="environment" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void decodePhoto(file); }} /></label>
            </>}
            <button type="button" className="secondary-button scan-close" onClick={closeScanner}>{tr("cancel")}</button>
          </section>
        </div>
      )}
    </>
  );
}
