"use client";

import { useEffect, useRef, useState } from "react";
import type { FocusEvent, InputHTMLAttributes, KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import type { MessageKey } from "@/i18n/messages";

export type ScanKind = "order" | "location" | "sku";

type Translator = (key: MessageKey, values?: Record<string, string>) => string;

/**
 * Normalize raw scanner payloads to the value the field expects.
 * Order barcodes may carry a prefix (e.g. `NLVW341151`); the numeric
 * component is the order identifier. Location/SKU values are visually
 * normalized the same way the server stores them.
 */
export function normalizeScannedValue(raw: string, kind: ScanKind): string {
  const trimmed = raw.trim();
  if (kind === "order") {
    const runs = trimmed.match(/\d+/g);
    // A single numeric run is an unambiguous order component (for example,
    // `NLVW341151`). Multiple runs need explicit correction instead of
    // silently selecting one (for example, `NLVW341151-02`).
    if (!runs || runs.length !== 1) return trimmed;
    return runs[0] ?? trimmed;
  }
  return trimmed.toUpperCase();
}

type DetectedBarcode = { rawValue: string };
type BarcodeDetectorInstance = { detect(source: ImageBitmapSource | Blob | ImageData): Promise<DetectedBarcode[]> };
type BarcodeDetectorConstructor = new (options?: { formats?: string[] }) => BarcodeDetectorInstance;

declare global {
  interface Window {
    BarcodeDetector?: BarcodeDetectorConstructor;
  }
}

function detectorConstructor(): BarcodeDetectorConstructor | null {
  if (typeof window === "undefined") return null;
  const available = "BarcodeDetector" in window ? window.BarcodeDetector : undefined;
  return typeof available === "function" ? available : null;
}

const SCAN_FORMATS = [
  "qr_code",
  "aztec",
  "data_matrix",
  "pdf417",
  "code_128",
  "code_39",
  "code_93",
  "codabar",
  "ean_13",
  "ean_8",
  "upc_a",
  "upc_e",
  "itf",
];

type ScanInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> & {
  value: string;
  onChange: (value: string) => void;
  /** Extra caller state to reset after a scan fills the field (e.g. duplicate warnings). */
  onScannedExtra?: () => void;
  tr: Translator;
  scanKind: ScanKind;
  /** Translated field name, used in the scan button's accessible label. */
  fieldLabel: string;
  type?: string;
};

export function ScanInput({ value, onChange, onScannedExtra, tr, scanKind, fieldLabel, id, onBlur, onKeyDown, ...inputProps }: ScanInputProps) {
  const [open, setOpen] = useState(false);
  const [supported, setSupported] = useState(false);
  const [error, setError] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const onChangeRef = useRef(onChange);
  const onScannedExtraRef = useRef(onScannedExtra);
  const kindRef = useRef(scanKind);
  const trRef = useRef(tr);
  useEffect(() => {
    onChangeRef.current = onChange;
    onScannedExtraRef.current = onScannedExtra;
    kindRef.current = scanKind;
    trRef.current = tr;
  });

  const openScanner = () => {
    setError("");
    setSupported(detectorConstructor() !== null);
    setOpen(true);
  };

  const closeScanner = () => {
    setOpen(false);
    setError("");
    inputRef.current?.focus();
  };

  const normalizeOrderField = (raw: string) => {
    if (scanKind !== "order") return;
    const normalized = normalizeScannedValue(raw, "order");
    if (normalized !== raw) onChange(normalized);
  };

  const handleBlur = (event: FocusEvent<HTMLInputElement>) => {
    // A wedge scanner commonly appends Enter, or the user clicks the submit
    // button after scanning. Normalize before either path validates the form.
    normalizeOrderField(event.currentTarget.value);
    onBlur?.(event);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && scanKind === "order") {
      const raw = event.currentTarget.value;
      const normalized = normalizeScannedValue(raw, "order");
      if (normalized !== raw) {
        // Enter's native form submit follows this keydown. Commit the parent
        // controlled value before that default action runs so onSubmit sees
        // the normalized order number.
        flushSync(() => onChange(normalized));
      }
    }
    onKeyDown?.(event);
  };

  useEffect(() => {
    if (!open || !supported) return;
    let stream: MediaStream | null = null;
    let frame = 0;
    let stopped = false;
    const applyDecoded = (raw: string) => {
      onChangeRef.current(normalizeScannedValue(raw, kindRef.current));
      onScannedExtraRef.current?.();
      setOpen(false);
      setError("");
    };
    const start = async () => {
      try {
        if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) throw new Error("no camera");
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        const ctor = detectorConstructor();
        if (!ctor) throw new Error("no detector");
        const detector = new ctor({ formats: SCAN_FORMATS });
        const tick = async () => {
          if (stopped || !videoRef.current) return;
          try {
            const results = await detector.detect(videoRef.current);
            const raw = results.length > 0 ? results[0]?.rawValue : undefined;
            if (raw) {
              applyDecoded(raw);
              return;
            }
          } catch {
            // Keep scanning; a single frame failure is not fatal.
          }
          frame = requestAnimationFrame(() => void tick());
        };
        void tick();
      } catch {
        if (!stopped) setError(trRef.current("scanCameraError"));
      }
    };
    void start();
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
    };
  }, [open, supported]);

  const decodePhoto = async (file: File) => {
    const ctor = detectorConstructor();
    if (!ctor) {
      setError(tr("scanNotSupported"));
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      try {
        const detector = new ctor({ formats: SCAN_FORMATS });
        const results = await detector.detect(bitmap);
        const raw = results.length > 0 ? results[0]?.rawValue : undefined;
        if (raw) {
          onChange(normalizeScannedValue(raw, scanKind));
          onScannedExtra?.();
          setOpen(false);
          setError("");
        } else {
          setError(tr("scanPhotoError"));
        }
      } finally {
        bitmap.close();
      }
    } catch {
      setError(tr("scanPhotoError"));
    }
  };

  return (
    <>
      <div className="scan-field">
        <input ref={inputRef} id={id} value={value} onChange={(event) => onChange(event.target.value)} onBlur={handleBlur} onKeyDown={handleKeyDown} {...inputProps} />
        <button
          type="button"
          className="scan-button"
          aria-label={tr("scanButtonLabel", { field: fieldLabel })}
          title={tr("scanButtonLabel", { field: fieldLabel })}
          onClick={openScanner}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" />
            <path d="M4 12h16" />
          </svg>
        </button>
      </div>
      {open && (
        <div
          className="scan-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeScanner();
          }}
        >
          <section className="scan-dialog" role="dialog" aria-modal="true" aria-label={tr("scanTitle")}>
            <h2>{tr("scanTitle")}</h2>
            <p>{tr("scanDescription")}</p>
            {!supported ? (
              <p className="scan-alert" role="alert">
                {tr("scanNotSupported")}
              </p>
            ) : (
              <>
                <video ref={videoRef} className="scan-video" muted playsInline aria-label={tr("scanTitle")} />
                {error ? (
                  <p className="scan-alert" role="alert">
                    {error}
                  </p>
                ) : (
                  <p className="scan-waiting" aria-live="polite">
                    {tr("scanWaiting")}
                  </p>
                )}
                <label className="scan-photo-label">
                  <span>{tr("scanFromPhoto")}</span>
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (file) void decodePhoto(file);
                    }}
                  />
                </label>
              </>
            )}
            <button type="button" className="secondary-button scan-close" onClick={closeScanner}>
              {tr("cancel")}
            </button>
          </section>
        </div>
      )}
    </>
  );
}
