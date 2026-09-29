"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PickerWorkflow } from "@/components/picker-workflow";
import { CheckWorkflow } from "@/components/check-workflow";
import { OperationsDashboard } from "@/components/operations-dashboard";
import { NotificationCenter } from "@/components/notification-center";
import { ConfigurationPanel } from "@/components/configuration-panel";
import { AnalyticsDashboard } from "@/components/analytics-dashboard";
import { ProfilePanel } from "@/components/profile-panel";
import { UserManagement } from "@/components/user-management";
import { PhotoApproval } from "@/components/photo-approval";
import { EnvironmentBanner } from "@/components/environment-banner";
import { ThemePicker } from "@/components/theme-picker";
import {
  getMessages,
  supportedLocales,
  translate,
  type Locale,
  type MessageKey,
} from "@/i18n/messages";

type AuthUser = {
  id: string;
  displayName: string;
  loginIdentifier: string;
  role: string;
  preferredLanguage: Locale;
  permissions: string[];
  canManageConfiguration: boolean;
};

type AuthResponse = { user?: AuthUser; loginIdentifier?: string; error?: string };
type View = "login" | "register" | "locked" | "registered" | "workspace";
type InviteRole = "PICKER" | "TROUBLESHOOTER" | "ASSISTANT" | "TEAM_LEADER";
type Invite = {
  id: string;
  expiresAt: string;
  maxRegistrations: number;
  registrationsUsed: number;
  defaultRole: InviteRole | "ADMIN";
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
};
type InviteResponse = { invites?: Invite[]; invite?: Invite & { token: string; registrationUrl: string }; error?: string };

type AuthAppProps = { initialInviteToken?: string; initialView?: View };

const navigation = [
  { key: "myWork", permission: ["REPORT_SHORT_PICK", "VIEW_OWN_CASES"] },
  { key: "checks", permission: ["VIEW_AVAILABLE_CHECKS", "CLAIM_CHECK", "COMPLETE_CHECK", "ASSIGN_CHECK", "REASSIGN_CHECK"] },
  { key: "openCases", permission: ["VIEW_ALL_OPEN_CASES"] },
  { key: "reports", permission: ["VIEW_ANALYTICS"] },
  { key: "notifications", permission: [] },
  { key: "invitations", permission: ["CREATE_INVITES"] },
  { key: "configuration", permission: ["MANAGE_CONFIGURATION"] },
  { key: "users", permission: ["VIEW_USERS", "APPROVE_PROFILE_PHOTO"] },
  { key: "profile", permission: [] },
] as const satisfies { key: MessageKey; permission: string[] }[];

function navigationFor(user: AuthUser) {
  return navigation.filter((item) => item.key === "notifications" || item.key === "profile" || (item.key === "configuration" && user.canManageConfiguration === true) || ((item.key !== "myWork" || user.role === "PICKER") && item.permission.some((permission) => user.permissions.includes(permission))));
}

const roleKeys: Record<InviteRole | "ADMIN", MessageKey> = {
  PICKER: "invitePicker",
  TROUBLESHOOTER: "inviteTroubleshooter",
  ASSISTANT: "inviteAssistant",
  TEAM_LEADER: "inviteTeamLeader",
  ADMIN: "inviteAdmin",
};

const inviteRolesByActor: Record<string, InviteRole[]> = {
  ASSISTANT: ["PICKER", "TROUBLESHOOTER"],
  TEAM_LEADER: ["PICKER", "TROUBLESHOOTER", "ASSISTANT"],
  ADMIN: ["PICKER", "TROUBLESHOOTER", "ASSISTANT", "TEAM_LEADER"],
};

const intlLocales: Record<Locale, string> = { en: "en-GB", nl: "nl-NL", pl: "pl-PL", es: "es-ES" };

function formatDate(value: string, locale: Locale) {
  return new Intl.DateTimeFormat(intlLocales[locale], { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

const languages: Record<Locale, string> = {
  en: "English",
  nl: "Nederlands",
  pl: "Polski",
  es: "Español",
};

function LanguagePicker({ locale, label, onChange }: { locale: Locale; label: string; onChange: (locale: Locale) => void }) {
  return (
    <label className="language-field">
      <span>{label}</span>
      <select value={locale} onChange={(event) => onChange(event.target.value as Locale)} aria-label={label}>
        {supportedLocales.map((language) => <option key={language} value={language}>{languages[language]}</option>)}
      </select>
    </label>
  );
}

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };

  if (name === "brand") {
    return (
      <svg {...common} viewBox="0 0 32 32" stroke="none" aria-hidden="true">
        <rect x="2" y="2" width="28" height="28" rx="8" fill="currentColor" />
        <path d="M9 11h14M9 16h10M9 21h7" stroke="white" strokeWidth="2" strokeLinecap="round" />
        <circle cx="23" cy="21" r="2.2" fill="#BFE3D7" />
      </svg>
    );
  }
  if (name === "openCases" || name === "myWork") {
    return <svg {...common}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 9h8M8 13h8M8 17h4" /></svg>;
  }
  if (name === "notifications") {
    return <svg {...common}><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z" /><path d="M10 21h4" /></svg>;
  }
  if (name === "checks") {
    return <svg {...common}><circle cx="12" cy="12" r="8.5" /><path d="m8.5 12 2.3 2.3 4.8-5" /></svg>;
  }
  if (name === "team") {
    return <svg {...common}><circle cx="9" cy="8" r="3" /><path d="M3.5 19v-1.5A4.5 4.5 0 0 1 8 13h2a4.5 4.5 0 0 1 4.5 4.5V19M16 5.5a3 3 0 0 1 0 5.8M17 14h.5a3.5 3.5 0 0 1 3 3.5V19" /></svg>;
  }
  if (name === "users") {
    return <svg {...common}><circle cx="9" cy="8" r="3" /><path d="M3.5 19v-1.5A4.5 4.5 0 0 1 8 13h2a4.5 4.5 0 0 1 4.5 4.5V19M16 5.5a3 3 0 0 1 0 5.8M17 14h.5a3.5 3.5 0 0 1 3 3.5V19" /></svg>;
  }
  if (name === "profile") {
    return <svg {...common}><circle cx="12" cy="8" r="3.5" /><path d="M4.5 20v-1.5A5.5 5.5 0 0 1 10 13h4a5.5 5.5 0 0 1 5.5 5.5V20" /></svg>;
  }
  if (name === "reports") {
    return <svg {...common}><path d="M4 19V5M4 19h16M8 16v-5M12 16V8M16 16v-8M20 16V4" /></svg>;
  }
  if (name === "settings") {
    return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="m19.4 15 .1.1a1.7 1.7 0 0 1-2.4 2.4l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a1.7 1.7 0 0 1-3.4 0v-.2a1.7 1.7 0 0 0-2.9-1.2l-.1.1a1.7 1.7 0 1 1-2.4-2.4l.1-.1a1.7 1.7 0 0 0-1.2-2.9H4a1.7 1.7 0 0 1 0-3.4h.2A1.7 1.7 0 0 0 5.4 5.8l-.1-.1a1.7 1.7 0 1 1 2.4-2.4l.1.1a1.7 1.7 0 0 0 2.9-1.2V2a1.7 1.7 0 0 1 3.4 0v.2A1.7 1.7 0 0 0 17 3.4l.1-.1a1.7 1.7 0 1 1 2.4 2.4l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a1.7 1.7 0 0 1 0 3.4h-.2a1.7 1.7 0 0 0-1.2 2.9Z" transform="translate(1 1) scale(.91)" /></svg>;
  }
  if (name === "invitations") {
    return <svg {...common}><path d="M7 3.75h7l4 4V20a1 1 0 0 1-1 1H7a2 2 0 0 1-2-2V5.75a2 2 0 0 1 2-2Z" /><path d="M14 4v4h4M8.5 12h6M8.5 16h6" /></svg>;
  }
  if (name === "lock") {
    return <svg {...common} strokeWidth={1.9}><rect x="5.5" y="10" width="13" height="10" rx="2" /><path d="M8 10V7.5a4 4 0 0 1 8 0V10M12 14v2" /></svg>;
  }
  return <svg {...common}><path d="M10 17l5-5-5-5M15 12H4M20 4v16" /></svg>;
}
type DeepLinkLine = {
  id: string;
  location?: string | null;
  originalLocation?: string | null;
  sku?: string | null;
  quantity?: number | null;
  missingQuantity?: number | null;
  state?: string | null;
  retrievalState?: string | null;
  discoveredLocation?: string | null;
  reporterName?: string | null;
  checkerName?: string | null;
  retrieverName?: string | null;
  replenishmentState?: string | null;
  replenishmentNote?: string | null;
  replenishmentActorName?: string | null;
  nextActionCode?: string | null;
  blockingReasonCode?: string | null;
};

type DeepLinkMessage = { id: string; message: string; authorName: string; createdAt: string };

type DeepLinkCase = {
  id: string;
  orderNumber: string;
  phase: string;
  pickerName?: string | null;
  responsibleName?: string | null;
  closedAt?: string | null;
  resolvedAt?: string | null;
  lines?: DeepLinkLine[] | null;
  messages?: DeepLinkMessage[] | null;
};

export function DeepCaseView({ tr, data, lineId, canViewMessages, status, onClose, headingRef, currentLineRef }: {
  tr: (key: MessageKey, values?: Record<string, string>) => string;
  data: DeepLinkCase | null;
  lineId: string | null;
  canViewMessages: boolean;
  status: "loading" | "ready" | "missing" | "forbidden" | "failed";
  onClose: () => void;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  currentLineRef: React.RefObject<HTMLElement | null>;
}) {
  if (status === "loading") {
    return (
      <section className="deep-case-panel" aria-labelledby="deep-case-title" aria-busy="true">
        <h2 id="deep-case-title" ref={headingRef} tabIndex={-1}>{tr("caseDeepLinkLoading")}</h2>
      </section>
    );
  }

  if (status !== "ready" || !data) {
    const messageKey = status === "missing" ? "caseDeepLinkNotFound" : status === "forbidden" ? "caseDeepLinkForbidden" : "caseLoadError";
    return (
      <section className="deep-case-panel" aria-labelledby="deep-case-title">
        <h2 id="deep-case-title" ref={headingRef} tabIndex={-1}>{tr("orderLabel")} …</h2>
        <p className="profile-message profile-error" role="alert">{tr(messageKey)}</p>
        <div className="dialog-actions"><button className="secondary-button" type="button" onClick={onClose}>{tr("caseDeepLinkClose")}</button></div>
      </section>
    );
  }

  const closed = data.phase === "CLOSED" || Boolean(data.closedAt || data.resolvedAt);
  const lines = data.lines ?? [];
  const visibleMessages = canViewMessages && Array.isArray(data.messages) ? data.messages : [];
  return (
    <section className="deep-case-panel" aria-labelledby="deep-case-title">
      <div className="deep-case-head">
        <h2 id="deep-case-title" ref={headingRef} tabIndex={-1}>{tr("orderLabel")} {data.orderNumber}</h2>
        {closed ? <span className="invite-status status-muted">{tr("caseClosedBadge")}</span> : null}
      </div>
      <p className="deep-case-meta">{data.phase === "STAGED" ? tr("phaseStaged") : data.phase === "CLOSED" ? tr("caseClosed") : tr("phasePicking")} · {data.pickerName || tr("unknownPicker")}</p>
      {closed ? <p className="profile-message" role="note">{tr("caseClosedReadOnlyNote")}</p> : null}
      {lines.length ? (
        <ul className="deep-case-lines">
          {lines.map((line) => {
            const current = lineId !== null && line.id === lineId;
            const quantity = line.missingQuantity ?? line.quantity;
            return (
              <li key={line.id}>
                <article className="deep-case-line" data-current={current ? "true" : "false"} aria-current={current ? "true" : undefined} ref={current ? currentLineRef : undefined}>
                  <div className="deep-case-line-top"><strong>{line.originalLocation || line.location || "—"}</strong><span>{line.sku || "—"} ×{typeof quantity === "number" ? quantity : "—"}</span></div>
                  <dl className="deep-case-facts">
                    <div><dt>{tr("lineOriginalLocation")}</dt><dd>{line.originalLocation || line.location || "—"}</dd></div>
                    <div><dt>{tr("lineKnownNewLocation")}</dt><dd>{line.discoveredLocation || tr("lineNoKnownNewLocation")}</dd></div>
                    {line.reporterName ? <div><dt>{tr("lineReporter")}</dt><dd>{line.reporterName}</dd></div> : null}
                    {line.checkerName ? <div><dt>{tr("lineChecker")}</dt><dd>{line.checkerName}</dd></div> : null}
                    {line.retrieverName ? <div><dt>{tr("lineRetriever")}</dt><dd>{line.retrieverName}</dd></div> : null}
                    {line.replenishmentState ? <div><dt>{tr("lineReplenishmentState")}</dt><dd>{tr(`replenishmentState${line.replenishmentState}` as MessageKey)}{line.replenishmentNote ? ` · ${line.replenishmentNote}` : ""}{line.replenishmentActorName ? ` · ${line.replenishmentActorName}` : ""}</dd></div> : null}
                    {line.nextActionCode ? <div><dt>{tr("lineNextStep")}</dt><dd>{tr(`nextAction${line.nextActionCode}` as MessageKey)}</dd></div> : null}
                    {line.blockingReasonCode ? <div><dt>{tr("attentionLevelLabel")}</dt><dd>{tr(`blockingReason${line.blockingReasonCode}` as MessageKey)}</dd></div> : null}
                  </dl>
                </article>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="profile-empty">{tr("noItemsYet")}</p>
      )}
      {visibleMessages.length > 0 ? (
        <section className="deep-case-messages" aria-label={tr("caseTimeline")}>
          <h3>{tr("caseTimeline")}</h3>
          <ol>
            {visibleMessages.map((entry) => (
              <li key={entry.id}><span><strong>{entry.authorName}</strong> · </span><span>{entry.message}</span></li>
            ))}
          </ol>
        </section>
      ) : null}
      <div className="dialog-actions"><button className="secondary-button" type="button" onClick={onClose}>{tr("caseDeepLinkClose")}</button></div>
    </section>
  );
}

function DeepCasePanel({ tr, caseId, lineId, canViewMessages, onClose }: {
  tr: (key: MessageKey, values?: Record<string, string>) => string;
  caseId: string;
  lineId: string | null;
  canViewMessages: boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<DeepLinkCase | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "missing" | "forbidden" | "failed">("loading");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const currentLineRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setStatus("loading");
      setData(null);
    });
    fetch(`/api/cases/${encodeURIComponent(caseId)}`, { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        const envelope = (await response.json().catch(() => ({}))) as { case?: DeepLinkCase };
        if (cancelled) return;
        if (response.status === 404) { setStatus("missing"); return; }
        if (response.status === 403) { setStatus("forbidden"); return; }
        const body = envelope.case;
        if (!response.ok || !body?.id) { setStatus("failed"); return; }
        setData({ ...body, lines: Array.isArray(body.lines) ? body.lines : [] });
        setStatus("ready");
      })
      .catch(() => { if (!cancelled) setStatus("failed"); });
    return () => { cancelled = true; };
  }, [caseId]);

  useEffect(() => {
    if (status === "ready" && lineId) currentLineRef.current?.scrollIntoView({ block: "nearest" });
    if (status !== "loading") headingRef.current?.focus();
  }, [status, lineId]);

  return <DeepCaseView tr={tr} data={data} lineId={lineId} canViewMessages={canViewMessages} status={status} onClose={onClose} headingRef={headingRef} currentLineRef={currentLineRef} />;
}

export function AuthApp({ initialInviteToken = "", initialView = "login" }: AuthAppProps) {
  const router = useRouter();
  const [view, setView] = useState<View>(initialInviteToken ? "register" : initialView);
  const [locale, setLocale] = useState<Locale>("en");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isCheckingSession, setIsCheckingSession] = useState(true);
  const [sessionError, setSessionError] = useState("");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [identifier, setIdentifier] = useState("");
  const [pin, setPin] = useState("");
  const [inviteToken, setInviteToken] = useState(initialInviteToken);
  const [displayName, setDisplayName] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [createdIdentifier, setCreatedIdentifier] = useState("");
  const [activeSection, setActiveSection] = useState<MessageKey>("workspace");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [invitesLoading, setInvitesLoading] = useState(true);
  const [inviteCheckTime, setInviteCheckTime] = useState(0);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [revokingId, setRevokingId] = useState("");
  const [inviteRole, setInviteRole] = useState<InviteRole>("PICKER");
  const [inviteMaxRegistrations, setInviteMaxRegistrations] = useState("1");
  const [inviteExpiresInHours, setInviteExpiresInHours] = useState("8");
  const [inviteUrl, setInviteUrl] = useState("");
  const [inviteNotice, setInviteNotice] = useState("");
  const [inviteError, setInviteError] = useState("");
  const [unreadCount, setUnreadCount] = useState(0);
  const [pendingPhotoCount, setPendingPhotoCount] = useState(0);
  const [deepCaseId, setDeepCaseId] = useState<string | null>(null);
  const [deepLineId, setDeepLineId] = useState<string | null>(null);
  const { messages: t } = getMessages(locale);
  const tr = useCallback((key: MessageKey, values?: Record<string, string>) => translate(t, key, values), [t]);
  const localeRef = useRef<Locale>(locale);
  const userRef = useRef<AuthUser | null>(null);
  const localeTouched = useRef(false);
  const trRef = useRef(tr);
  useEffect(() => { trRef.current = tr; }, [tr]);
  const pushLocaleToServer = useCallback(async (next: Locale) => {
    try {
      const response = await fetch("/api/profile", { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ preferredLanguage: next }) });
      if (response.ok) setUser((current) => (current ? { ...current, preferredLanguage: next } : current));
    } catch { /* Local selection stands; a later change or profile save syncs it. */ }
  }, []);
  const changeLocale = useCallback((next: Locale) => {
    localeTouched.current = true;
    setLocale(next);
    if (userRef.current) void pushLocaleToServer(next);
  }, [pushLocaleToServer]);

  useEffect(() => {
    if (!initialInviteToken) return;
    router.replace("/register", { scroll: false });
  }, [initialInviteToken, router]);

  useEffect(() => {
    let cancelled = false;
    const storedLocale = typeof window === "undefined" ? null : window.localStorage.getItem("short-pick-language");
    const initialLocale = storedLocale && supportedLocales.includes(storedLocale as Locale) ? (storedLocale as Locale) : null;
    if (initialLocale) {
      localeRef.current = initialLocale;
      queueMicrotask(() => { if (!cancelled) setLocale(initialLocale); });
    }
    const readSession = async () => {
      try {
        const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
        if (response.ok) {
          const body = (await response.json()) as AuthResponse;
          if (!cancelled && body.user) {
            setUser(body.user);
            const serverLocale = body.user.preferredLanguage || "en";
            if (localeTouched.current) {
              if (localeRef.current !== serverLocale) void pushLocaleToServer(localeRef.current);
              localeTouched.current = false;
            } else {
              setLocale(serverLocale);
              localeRef.current = serverLocale;
            }
            const firstSection = navigationFor(body.user).at(0);
            const params = new URLSearchParams(window.location.search);
            const deepCase = window.location.pathname === "/" ? params.get("case") : null;
            const deepLine = window.location.pathname === "/" ? params.get("line") : null;
            const requestedSection = window.location.pathname === "/"
              && params.get("section") === "notifications";
            if (deepCase) {
              setDeepCaseId(deepCase);
              setDeepLineId(deepLine);
              setActiveSection(firstSection?.key ?? "workspace");
            } else setActiveSection(requestedSection ? "notifications" : firstSection?.key ?? "workspace");
            setView("workspace");
            if (requestedSection) router.replace("/", { scroll: false });
          }
        } else if (response.status !== 401 && !cancelled) {
          setSessionError(trRef.current("sessionError"));
        }
      } catch {
        if (!cancelled) setSessionError(trRef.current("sessionError"));
      } finally {
        if (!cancelled) setIsCheckingSession(false);
      }
    };
    void readSession();
    return () => { cancelled = true; };
  }, [router, pushLocaleToServer]);

  useEffect(() => {
    localeRef.current = locale;
    userRef.current = user;
    if (typeof window !== "undefined") window.localStorage.setItem("short-pick-language", locale);
  }, [locale, user]);

  const allowedNavigation = useMemo(() => {
    if (!user) return [];
    return navigationFor(user);
  }, [user]);
  useEffect(() => {
    if (!user || view !== "workspace") return;
    let cancelled = false;
    const refreshBadges = async () => {
      try {
        const response = await fetch("/api/notifications", { credentials: "same-origin", cache: "no-store" });
        if (response.ok) {
          const body = (await response.json()) as { unreadCount?: number };
          if (!cancelled && typeof body.unreadCount === "number") setUnreadCount(body.unreadCount);
        }
      } catch { /* badge-only; center shows errors */ }
      if (!user.permissions.includes("APPROVE_PROFILE_PHOTO") && user.role !== "ADMIN") {
        if (!cancelled) setPendingPhotoCount(0);
        return;
      }
      try {
        const response = await fetch("/api/admin/profile-photos", { credentials: "same-origin", cache: "no-store" });
        if (response.ok) {
          const body = (await response.json()) as { photos?: unknown[] };
          if (!cancelled) setPendingPhotoCount(Array.isArray(body.photos) ? body.photos.length : 0);
        }
      } catch { /* badge-only; queue shows errors */ }
    };
    void refreshBadges();
    const timer = window.setInterval(() => { void refreshBadges(); }, 15_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [user, view, activeSection]);

  const canCreateInvites = user?.role === "ADMIN" || Boolean(user?.permissions.includes("CREATE_INVITES"));
  const canUsePickerWorkflow = user?.role === "PICKER" && Boolean(user.permissions.some((permission) => permission === "REPORT_SHORT_PICK" || permission === "VIEW_OWN_CASES"));
  const canOverrideDuplicateLine = Boolean(user?.permissions.includes("OVERRIDE_DUPLICATE_SHORT_PICK_LINE"));
  const assignableRoles = user ? inviteRolesByActor[user.role] ?? [] : [];
  const openCaseFromNotification = useCallback((caseId: string, lineId: string | null) => {
    setDeepCaseId(caseId);
    setDeepLineId(lineId);
    router.replace(`/?case=${encodeURIComponent(caseId)}${lineId ? `&line=${encodeURIComponent(lineId)}` : ""}`, { scroll: false });
  }, [router]);

  const closeDeepCase = useCallback(() => {
    setDeepCaseId(null);
    setDeepLineId(null);
    router.replace("/", { scroll: false });
  }, [router]);

  const selectSection = useCallback((section: MessageKey) => {
    setDeepCaseId(null);
    setDeepLineId(null);
    setActiveSection(section);
    setMobileNavOpen(false);
    router.replace("/", { scroll: false });
  }, [router]);

  const loadInvites = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/invites", { credentials: "same-origin", cache: "no-store" });
      const body = (await response.json()) as InviteResponse;
      if (!response.ok) throw new Error(body.error || tr("unknownError"));
      setInvites(body.invites || []);
      setInviteCheckTime(Date.now());
      setInviteError("");
    } catch (error) {
      setInviteError(error instanceof Error ? error.message : tr("unknownError"));
    } finally {
      setInvitesLoading(false);
    }
  }, [tr]);

  useEffect(() => {
    if (view !== "workspace" || !canCreateInvites) return;
    let cancelled = false;
    fetch("/api/admin/invites", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json()) as InviteResponse;
        if (!response.ok) throw new Error(body.error || tr("unknownError"));
        if (!cancelled) {
          setInvites(body.invites || []);
          setInviteCheckTime(Date.now());
          setInviteError("");
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setInviteError(error instanceof Error ? error.message : tr("unknownError"));
      })
      .finally(() => {
        if (!cancelled) setInvitesLoading(false);
      });
    return () => { cancelled = true; };
  }, [view, canCreateInvites, tr]);

  const switchView = (nextView: View) => {
    setFormError("");
    setSessionError("");
    setView(nextView);
  };

  const handleLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError("");
    if (!identifier.trim() || !pin) {
      setFormError(tr("required"));
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ identifier: identifier.trim(), pin }),
      });
      const body = (await response.json()) as AuthResponse;
      if (!response.ok || !body.user) {
        const message = body.error || tr("unknownError");
        if (/lock|too many|attempts/i.test(message)) {
          setFormError(message);
          setView("locked");
        } else setFormError(message);
        return;
      }
      setUser(body.user);
      if (localeTouched.current && locale !== body.user.preferredLanguage) {
        void pushLocaleToServer(locale);
        localeTouched.current = false;
      } else {
        setLocale(body.user.preferredLanguage || locale);
        localeRef.current = body.user.preferredLanguage || locale;
      }
      const firstSection = navigationFor(body.user);
      setActiveSection(firstSection.at(0)?.key ?? "workspace");
      setView("workspace");
      setPin("");
    } catch {
      setFormError(tr("unknownError"));
    } finally {
      setBusy(false);
    }
  };

  const handleRegistration = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError("");
    if (!inviteToken.trim() || !displayName.trim() || !pin || !confirmPin) {
      setFormError(tr("required"));
      return;
    }
    if (!/^\d{6,}$/.test(pin)) {
      setFormError(tr("pinLength"));
      return;
    }
    if (pin !== confirmPin) {
      setFormError(tr("pinMismatch"));
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          inviteToken: inviteToken.trim(),
          displayName: displayName.trim(),
          pin,
          preferredLanguage: locale,
        }),
      });
      const body = (await response.json()) as AuthResponse;
      if (!response.ok || !body.user) {
        setFormError(body.error || tr("unknownError"));
        return;
      }
      setUser(body.user);
      setCreatedIdentifier(body.loginIdentifier || body.user.loginIdentifier);
      setLocale(body.user.preferredLanguage || locale);
      localeRef.current = body.user.preferredLanguage || locale;
      localeTouched.current = false;
      setInviteToken("");
      setPin("");
      setConfirmPin("");
      const firstSection = navigationFor(body.user);
      setActiveSection(firstSection.at(0)?.key ?? "workspace");
      setView("registered");
    } catch {
      setFormError(tr("unknownError"));
    } finally {
      setBusy(false);
    }
  };

  const handleCreateInvite = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setInviteError("");
    setInviteNotice("");
    if (!assignableRoles.includes(inviteRole)) {
      setInviteError(tr("unknownError"));
      return;
    }
    const maxRegistrations = Number(inviteMaxRegistrations);
    const expiresInHours = Number(inviteExpiresInHours);
    if (!Number.isInteger(maxRegistrations) || maxRegistrations < 1 || maxRegistrations > 1000 || !Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 720) {
      setInviteError(tr("inviteInvalidSettings"));
      return;
    }
    setInviteBusy(true);
    setInvitesLoading(true);
    try {
      const response = await fetch("/api/admin/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ defaultRole: inviteRole, expiresInHours, maxRegistrations }),
      });
      const body = (await response.json()) as InviteResponse;
      if (!response.ok || !body.invite) {
        setInviteError(body.error || tr("unknownError"));
        return;
      }
      setInviteUrl(new URL(body.invite.registrationUrl, window.location.origin).href);
      setInviteNotice(tr("inviteCreated"));
      await loadInvites();
    } catch {
      setInviteError(tr("unknownError"));
    } finally {
      setInviteBusy(false);
    }
  };

  const handleCopyInvite = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setInviteNotice(tr("inviteCopied"));
    } catch {
      setInviteError(tr("inviteCopyFailed"));
    }
  };

  const handleRevokeInvite = async (invite: Invite) => {
    if (!window.confirm(tr("inviteRevokeConfirm"))) return;
    setRevokingId(invite.id);
    setInviteError("");
    setInviteNotice("");
    setInvitesLoading(true);
    try {
      const response = await fetch(`/api/admin/invites/${encodeURIComponent(invite.id)}`, { method: "DELETE", credentials: "same-origin" });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        setInviteError(body.error || tr("unknownError"));
        return;
      }
      await loadInvites();
    } catch {
      setInviteError(tr("unknownError"));
    } finally {
      setRevokingId("");
    }
  };

  const handleLogout = async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
      if (!response.ok) throw new Error("Logout failed");
      setUser(null);
      setIdentifier("");
      setPin("");
      localeTouched.current = false;
      router.replace("/");
      switchView("login");
    } catch {
      setFormError(tr("unknownError"));
    } finally {
      setBusy(false);
    }
  };

  if (isCheckingSession) {
    return <main className="auth-loading" aria-live="polite"><span className="loading-mark"><Icon name="brand" size={32} /></span><p>{tr("loading")}</p></main>;
  }

  if (view === "workspace" && user) {
    return (
      <>
        <EnvironmentBanner tr={tr} />
      <div className="app-shell">
        {mobileNavOpen && <button className="nav-scrim" aria-label={tr("closeMenu")} onClick={() => setMobileNavOpen(false)} />}
        <aside className={`sidebar${mobileNavOpen ? " sidebar-open" : ""}`}>
          <div className="sidebar-brand"><span className="brand-mark"><Icon name="brand" size={30} /></span><span>{tr("brand")}</span></div>
          {allowedNavigation.length > 0 && <div className="sidebar-label">{tr("workspace")}</div>}
          <nav className="primary-navigation" aria-label={tr("workspace")}>
            {allowedNavigation.map((item) => (
              <button
                key={item.key}
                className={`nav-item${activeSection === item.key ? " nav-item-active" : ""}`}
                onClick={() => selectSection(item.key)}
                aria-current={activeSection === item.key ? "page" : undefined}
              >
                <Icon name={item.key} />
                <span className="nav-item-label">{tr(item.key)}</span>
                {item.key === "notifications" && unreadCount > 0 && <span className="nav-badge" aria-label={tr("notificationsUnread", { count: String(unreadCount) })}>{unreadCount > 99 ? "99+" : unreadCount}</span>}
                {item.key === "users" && pendingPhotoCount > 0 && <span className="nav-badge" aria-label={tr("photoPendingBadge", { count: String(pendingPhotoCount) })}>{pendingPhotoCount > 99 ? "99+" : pendingPhotoCount}</span>}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="account-row">
              <span className="avatar" aria-hidden="true">{user.displayName.slice(0, 1).toUpperCase()}</span>
              <span className="account-copy"><strong>{user.displayName}</strong><small>{roleKeys[user.role as InviteRole | "ADMIN"] ? tr(roleKeys[user.role as InviteRole | "ADMIN"]) : user.role}</small></span>
            </div>
            <button className="nav-item signout-nav" onClick={handleLogout} disabled={busy}>
              <Icon name="signOut" /><span className="nav-item-label">{busy ? tr("signingOut") : tr("signOut")}</span>
            </button>
          </div>
        </aside>
        <div className="shell-main">
          <header className="topbar">
            <button className="mobile-menu-button" onClick={() => setMobileNavOpen(true)} aria-label={tr("mobileMenu")} aria-expanded={mobileNavOpen}>
              <span /><span /><span />
            </button>
            <div className="breadcrumb"><span>{tr("workspace")}</span><span className="breadcrumb-divider">/</span><strong>{tr(activeSection)}</strong></div>
            <div className="topbar-actions"><ThemePicker tr={tr} /><LanguagePicker locale={locale} label={tr("language")} onChange={changeLocale} /><span className="avatar avatar-small" aria-hidden="true">{user.displayName.slice(0, 1).toUpperCase()}</span></div>
          </header>
          <main className="workspace-content">
            {deepCaseId ? (
              <DeepCasePanel tr={tr} caseId={deepCaseId} lineId={deepLineId} canViewMessages={user.permissions.includes("VIEW_CASE_MESSAGES")} onClose={closeDeepCase} />
            ) : null}
            {activeSection === "configuration" && allowedNavigation.some((item) => item.key === "configuration") ? (
              <ConfigurationPanel tr={tr} locale={locale} role={user.role} />
            ) : activeSection === "profile" ? (
              <ProfilePanel locale={locale} tr={tr} onLanguageChange={changeLocale} />
            ) : activeSection === "users" && allowedNavigation.some((item) => item.key === "users") ? (
              <>{user.permissions.includes("VIEW_USERS") || user.role === "ADMIN" ? <UserManagement actorId={user.id} actorRole={user.role} actorPermissions={user.permissions} tr={tr} /> : null}
                {user.permissions.includes("APPROVE_PROFILE_PHOTO") || user.role === "ADMIN" ? <PhotoApproval locale={locale} tr={tr} onQueueChange={setPendingPhotoCount} /> : null}</>
            ) : activeSection === "openCases" && allowedNavigation.some((item) => item.key === "openCases") ? (
              <OperationsDashboard
                tr={tr}
                locale={locale}
                canCreateManual={user.permissions.includes("CREATE_CASE_ON_BEHALF")}
                canMessage={user.permissions.includes("ADD_CASE_MESSAGE")}
                canAssign={user.permissions.includes("ASSIGN_TROUBLESHOOTER")}
                canClose={user.permissions.includes("RESOLVE_CASE")}
                canReopen={user.permissions.includes("REOPEN_CASE")}
              />
            ) : activeSection === "notifications" ? (
              <NotificationCenter
                tr={tr}
                locale={locale}
                canManagePreferences={user.permissions.includes("VIEW_ALL_OPEN_CASES")}
                onOpenCase={(caseId, lineId) => openCaseFromNotification(caseId, lineId ?? null)}
                onReviewPhotos={user.permissions.includes("APPROVE_PROFILE_PHOTO") || user.role === "ADMIN" ? () => selectSection("users") : undefined}
                onUnreadChange={setUnreadCount}
              />
            ) : activeSection === "reports" && allowedNavigation.some((item) => item.key === "reports") ? (
              <AnalyticsDashboard tr={tr} locale={locale} canExport={user.permissions.includes("EXPORT_ANALYTICS")} />
            ) : canUsePickerWorkflow && activeSection === "myWork" ? (
              <PickerWorkflow locale={locale} tr={tr} userId={user.id} canReportShortPick={Boolean(user.permissions.includes("REPORT_SHORT_PICK"))} canViewOwnCases={Boolean(user.permissions.includes("VIEW_OWN_CASES"))} canOverrideDuplicateLine={canOverrideDuplicateLine} canStage={user.permissions.includes("MARK_ORDER_STAGED")} canConfirmRetrieval={user.permissions.includes("CONFIRM_RETRIEVAL")} canClose={user.permissions.includes("RESOLVE_CASE")} />
            ) : activeSection === "checks" && allowedNavigation.some((item) => item.key === "checks") ? (
              <CheckWorkflow locale={locale} tr={tr} canViewAvailable={user.permissions.includes("VIEW_AVAILABLE_CHECKS") || user.permissions.includes("ASSIGN_CHECK")} canClaim={user.permissions.includes("CLAIM_CHECK")} canComplete={user.permissions.includes("COMPLETE_CHECK")} canAssign={user.permissions.includes("ASSIGN_CHECK")} canReassign={user.permissions.includes("REASSIGN_CHECK")} canRetrieve={user.permissions.includes("CONFIRM_RETRIEVAL")} canMessage={user.permissions.includes("ADD_CASE_MESSAGE")} />
            ) : canCreateInvites && activeSection === "invitations" ? (
              <>
                <div className="content-heading"><div><h1>{tr("inviteManagementTitle")}</h1><p>{tr("inviteManagementDescription")}</p></div></div>
                <section className="invite-create-panel" aria-labelledby="invite-create-title">
                  <h2 id="invite-create-title">{tr("newInviteTitle")}</h2>
                  <form className="invite-form" onSubmit={handleCreateInvite}>
                    <label className="form-field"><span>{tr("inviteRole")}</span><select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as InviteRole)}>
                      {assignableRoles.map((role) => <option value={role} key={role}>{tr(roleKeys[role])}</option>)}
                    </select></label>
                    <label className="form-field"><span>{tr("maxRegistrations")}</span><input type="number" min={1} max={1000} step={1} inputMode="numeric" value={inviteMaxRegistrations} onChange={(event) => setInviteMaxRegistrations(event.target.value)} /></label>
                    <label className="form-field"><span>{tr("expiresInHours")}</span><input type="number" min={1} max={720} step={1} inputMode="numeric" value={inviteExpiresInHours} onChange={(event) => setInviteExpiresInHours(event.target.value)} /></label>
                    <button className="primary-button invite-submit" type="submit" disabled={inviteBusy || assignableRoles.length === 0}>{inviteBusy ? tr("creatingInvite") : tr("createInvite")}</button>
                  </form>
                  {inviteError && <p className="invite-message invite-error" role="alert">{inviteError}</p>}
                  {inviteNotice && <p className="invite-message invite-success" role="status">{inviteNotice}</p>}
                  {inviteUrl && <div className="new-invite-link">
                    <label className="form-field"><span>{tr("inviteUrl")}</span><input readOnly value={inviteUrl} onFocus={(event) => event.currentTarget.select()} /></label>
                    <button type="button" className="copy-button" onClick={handleCopyInvite}>{tr("inviteCopyLink")}</button>
                  </div>}
                </section>
                <section className="invite-list-section" aria-labelledby="invite-list-title">
                  <div className="invite-list-heading"><h2 id="invite-list-title">{tr("inviteListTitle")}</h2></div>
                  {invitesLoading ? <p className="invite-empty" aria-live="polite">{tr("loading")}</p> : invites.length === 0 ? <p className="invite-empty">{tr("inviteListEmpty")}</p> : (
                    <div className="invite-list">
                      {invites.map((invite) => {
                        const isExpired = inviteCheckTime > 0 && new Date(invite.expiresAt).getTime() <= inviteCheckTime;
                        const isRevoked = Boolean(invite.revokedAt);
                        const isExhausted = invite.registrationsUsed >= invite.maxRegistrations;
                        const statusKey = isRevoked ? "inviteRevoked" : isExpired ? "inviteExpired" : isExhausted ? "inviteExhausted" : "inviteActive";
                        const statusClass = isRevoked || isExpired ? "status-muted" : isExhausted ? "status-full" : "status-active";
                        return <article className="invite-row" key={invite.id}>
                          <div className="invite-row-primary"><strong>{tr(roleKeys[invite.defaultRole])}</strong><span className={`invite-status ${statusClass}`}>{tr(statusKey)}</span></div>
                          <div className="invite-row-details"><span>{tr("inviteRegistrations", { used: String(invite.registrationsUsed), max: String(invite.maxRegistrations) })}</span><span>{tr("inviteCreatedAt")}: {formatDate(invite.createdAt, locale)}</span><span>{tr("inviteExpiresAt")}: {formatDate(invite.expiresAt, locale)}</span></div>
                          {!(isRevoked || isExpired || isExhausted) && <button type="button" className="revoke-button" disabled={revokingId === invite.id} onClick={() => void handleRevokeInvite(invite)}>{revokingId === invite.id ? tr("inviteRevoking") : tr("inviteRevoke")}</button>}
                        </article>;
                      })}
                    </div>
                  )}
                </section>
              </>
            ) : (
              <>
                <div className="content-heading"><div><h1>{tr("workspaceWelcome", { name: user.displayName })}</h1><p>{tr("workspaceDescription")}</p></div></div>
                <section className="empty-workspace" aria-labelledby="empty-title">
                  <div className="empty-icon"><Icon name="myWork" size={25} /></div>
                  <h2 id="empty-title">{tr("workspaceEmptyTitle")}</h2>
                  <p>{tr("workspaceEmptyDescription")}</p>
                </section>
              </>
            )}
          </main>
        </div>
        </div>
      </>
    );
  }

  return (
      <>
      <EnvironmentBanner tr={tr} />
    <main className="auth-page">
      <section className="auth-intro" aria-label={tr("brand")}>
        <Link className="auth-brand" href="/" onClick={() => switchView("login")}>
          <span className="brand-mark"><Icon name="brand" size={32} /></span><span>{tr("brand")}</span>
        </Link>
        <p className="auth-tagline">{tr("tagline")}</p>
        <div className="intro-rule" />
        <p className="intro-note">{view === "register" ? tr("registrationOnlyByInvite") : tr("loginDescription")}</p>
      </section>

      <section className="auth-panel">
        <div className="auth-panel-top"><span className="brand-mark brand-mark-small"><Icon name="brand" size={25} /></span><div className="auth-controls"><ThemePicker tr={tr} /><LanguagePicker locale={locale} label={tr("language")} onChange={changeLocale} /></div></div>
        {view === "login" && (
          <div className="auth-form-wrap">
            <div className="auth-heading"><h1>{tr("loginTitle")}</h1><p>{tr("loginDescription")}</p></div>
            {(formError || sessionError) && <div className="form-alert" role="alert"><strong>{tr("errorHeading")}</strong><span>{formError || sessionError}</span></div>}
            <form onSubmit={handleLogin} noValidate>
              <label className="form-field"><span>{tr("identifier")}</span><input autoComplete="username" name="identifier" value={identifier} onChange={(event) => setIdentifier(event.target.value)} placeholder={tr("identifierPlaceholder")} required autoCapitalize="none" /></label>
              <label className="form-field"><span>{tr("loginCredential")}</span><input autoComplete="current-password" name="pin" type="password" value={pin} onChange={(event) => setPin(event.target.value)} placeholder={tr("loginCredentialPlaceholder")} required /></label>
              <button className="primary-button" type="submit" disabled={busy}>{busy ? tr("signingIn") : tr("signIn")}</button>
            </form>
            <p className="auth-switch">{tr("invitePrompt")} <Link href="/register">{tr("registerLink")}</Link></p>
          </div>
        )}

        {view === "register" && (
          <div className="auth-form-wrap">
            <div className="auth-heading"><h1>{tr("registerTitle")}</h1><p>{tr("registerDescription")}</p></div>
            {formError && <div className="form-alert" role="alert"><strong>{tr("errorHeading")}</strong><span>{formError}</span></div>}
            <form onSubmit={handleRegistration} noValidate>
              <label className="form-field"><span>{tr("inviteToken")}</span><input autoComplete="off" name="inviteToken" value={inviteToken} onChange={(event) => setInviteToken(event.target.value)} placeholder={tr("invitePlaceholder")} required /></label>
              <label className="form-field"><span>{tr("displayName")}</span><input autoComplete="name" name="displayName" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder={tr("displayNamePlaceholder")} required /></label>
              <label className="form-field"><span>{tr("pin")}</span><input autoComplete="new-password" name="pin" type="password" inputMode="numeric" pattern="[0-9]*" value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))} placeholder={tr("pinPlaceholder")} minLength={6} required /></label>
              <label className="form-field"><span>{tr("confirmPin")}</span><input autoComplete="new-password" name="confirmPin" type="password" inputMode="numeric" pattern="[0-9]*" value={confirmPin} onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, ""))} placeholder={tr("confirmPinPlaceholder")} minLength={6} required /></label>
              <button className="primary-button" type="submit" disabled={busy}>{busy ? tr("creatingAccount") : tr("createAccount")}</button>
            </form>
            <p className="auth-switch"><Link href="/" onClick={() => switchView("login")}>{tr("backToSignIn")}</Link></p>
          </div>
        )}

        {view === "locked" && (
          <div className="locked-state">
            <div className="locked-icon"><Icon name="lock" size={26} /></div>
            <h1>{tr("lockedTitle")}</h1>
            <p className="locked-lead">{formError || tr("lockedDescription")}</p>
            <div className="locked-help"><p>{tr("lockedHelp")}</p></div>
            <button className="secondary-button" onClick={() => switchView("login")}>{tr("lockedBack")}</button>
          </div>
        )}

        {view === "registered" && user && (
          <div className="registered-state">
            <div className="success-mark" aria-hidden="true">✓</div>
            <h1>{tr("registrationSuccess")}</h1>
            <p>{tr("registrationSuccessDescription")}</p>
            <div className="identifier-card"><span>{tr("yourWorkerId")}</span><strong>{createdIdentifier}</strong></div>
            <button className="primary-button" onClick={() => router.replace("/")}>{tr("continueToWorkspace")}</button>
          </div>
        )}
        <div className="auth-panel-footer"><span>{tr("brand")}</span></div>
      </section>
    </main>
      </>
  );
}
