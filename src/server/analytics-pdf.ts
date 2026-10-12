import { isSameLocationReporter } from "@/domain/analytics-same-location";
import type { AnalyticsManagement, PeriodTotals } from "@/domain/analytics-management";
import PDFDocument from "pdfkit";
import { join } from "node:path";
import { getMessages, translate, type MessageKey, type Locale } from "@/i18n/messages";

/**
 * The PDF deliberately consumes the analytics response shape rather than
 * issuing a second set of queries. This keeps dashboard and export filters in
 * lockstep and lets the analytics service enforce its row/event bounds.
 */
export type AnalyticsFilters = {
  from?: string | Date;
  to?: string | Date;
  orderNumber?: string;
  location?: string;
  sku?: string;
  phase?: string;
  resolution?: string;
  source?: string;
  configVersion?: string;
  pickerUserId?: string;
  checkerUserId?: string;
  troubleshooterUserId?: string;
};

export type AnalyticsReportData = {
  management?: AnalyticsManagement;
  filters?: AnalyticsFilters;
  kpis?: Record<string, unknown>;
  duplicates?: { repeatedOrderCount?: number; orders?: Array<Record<string, unknown>> };
  rows?: { cases?: Array<Record<string, unknown>>; lines?: Array<Record<string, unknown>> };
  limits?: Record<string, unknown>;
  configurationContext?: unknown;
};

export type PdfReportOptions = {
  generatedAt?: Date;
  companyName?: string;
  title?: string;
  language?: string;
};

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 42;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const FOOTER_HEIGHT = 28;
const MAX_RENDER_ROWS = 5_000;
const INK = "#172033";
const MUTED = "#64748b";
const BRAND = "#0f766e";
const RULE = "#dbe4ed";
const ALT_ROW = "#f8fafc";
const REPORT_REGULAR = "ReportSans";
const REPORT_BOLD = "ReportSansBold";
const ACTIVE_FILTER_KEYS = ["from", "to", "orderNumber", "location", "sku", "phase", "resolution", "source", "configVersion", "pickerUserId", "checkerUserId", "troubleshooterUserId", "role"] as const;
const MAX_DUPLICATE_DATE_ROWS = 1_000;

type PdfCopy = {
  reportTitle: string;
  generated: string;
  reportScope: string;
  reportScopeDescription: string;
  allFilters: string;
  kpiSummary: string;
  kpiSummaryDescription: string;
  selectedCharts: string;
  selectedChartsDescription: string;
  lineOutcomes: string;
  repeatedOrders: string;
  repeatedSummary: (count: string) => string;
  duplicateLimit: (shown: string, total: string) => string;
  noDuplicates: string;
  caseDetail: string;
  casesIncluded: (shown: string, total: string, limited: boolean) => string;
  lineDetail: string;
  linesIncluded: (shown: string, total: string, limited: boolean) => string;
  configurationContext: string;
  configurationDescription: string;
  configurationUnavailable: string;
  noCases: string;
  noLines: string;
  order: string;
  phase: string;
  source: string;
  lines: string;
  created: string;
  resolved: string;
  location: string;
  sku: string;
  quantity: string;
  state: string;
  resolution: string;
  configurationVersion: string;
  cases: string;
  occurrence: string;
  caseDates: string;
  na: string;
  pagination: string;
  page: string;
  omittedDates: (count: string) => string;
  analyticsResolutionFoundAtOriginal: string;
  analyticsRoleFilter: string;
  analyticsSameLocationTitle: string;
  analyticsSameLocationDescription: string;
  analyticsSameLocationEligible: string;
  analyticsSameLocationRate: string;
  analyticsSameLocationRateHidden: string;
  analyticsSameLocationCountsOnly: string;
  analyticsSameLocationOutcomes: string;
  analyticsSameLocationReporter: string;
  analyticsSameLocationOutcomeCounts: string;
  analyticsSameLocationDateRange: string;
  analyticsSameLocationExport: string;
};

type PdfLabels = PdfCopy & Pick<ReturnType<typeof getMessages>["messages"],
  | "analyticsFrom" | "analyticsTo" | "orderNumber" | "location" | "sku"
  | "analyticsPhase" | "analyticsResolution" | "analyticsSource" | "analyticsConfiguration"
  | "analyticsPicker" | "analyticsChecker" | "analyticsTroubleshooter"
  | "analyticsTotalCases" | "analyticsTotalLines" | "analyticsFound" | "analyticsNotFound"
  | "analyticsWrongLocation" | "analyticsRetrieved" | "analyticsOverThreshold"
  | "analyticsManualCases" | "analyticsReopenedCases" | "analyticsRepeatedOrders"
  | "analyticsReportToClaim" | "analyticsReportToFound" | "analyticsReportToRetrieval"
  | "analyticsReportToResolution" | "analyticsLinesByLocation" | "analyticsLinesBySku"
  | "analyticsPhasePicking" | "analyticsPhaseStaged" | "analyticsPhaseClosed"
  | "analyticsResolutionFound" | "analyticsResolutionNotFound" | "analyticsResolutionWrongLocation"
  | "analyticsResolutionOther" | "analyticsSourcePickerReport" | "analyticsSourceTlManual"
  | "analyticsSourceAssistantManual" | "analyticsSourceManagerManual" | "analyticsSourceAdminManual"
  | "caseOpen" | "caseChecking" | "caseFound" | "caseRetrieved" | "caseClosed" | "caseCancelled"
>;

export const ANALYTICS_PDF_FALLBACK_COPY = {
  analyticsResolutionFoundAtOriginal: "Found at original location",
  analyticsRoleFilter: "Role",
  analyticsSameLocationTitle: "Same-location-found",
  analyticsSameLocationDescription: "Counts are shown for every user; the rate appears only with 20 or more eligible lines. No rankings.",
  analyticsSameLocationEligible: "Found at original / eligible lines",
  analyticsSameLocationRate: "Same-location rate",
  analyticsSameLocationRateHidden: "Rate hidden: fewer than 20 eligible lines",
  analyticsSameLocationCountsOnly: "counts only",
  analyticsSameLocationOutcomes: "FOUND_AT_ORIGINAL / FOUND / NOT_FOUND / WRONG_LOCATION",
  analyticsSameLocationReporter: "Reporter",
  analyticsSameLocationOutcomeCounts: "Outcome counts",
  analyticsSameLocationDateRange: "Date range",
  analyticsSameLocationExport: "Export per-user CSV",
} as const;

function sameLocationDictCopy(messages: {
  analyticsResolutionFoundAtOriginal: string; analyticsSameLocationTitle: string;
  analyticsSameLocationDescription: string; analyticsSameLocationEligible: string;
  analyticsSameLocationRate: string; analyticsSameLocationRateHidden: string;
  analyticsSameLocationCountsOnly: string; analyticsSameLocationOutcomes: string;
  analyticsSameLocationReporter: string; analyticsSameLocationOutcomeCounts: string;
  analyticsSameLocationDateRange: string; analyticsSameLocationDateRangeValue: string;
  analyticsSameLocationExport: string; analyticsRoleFilter: string;
}) {
  return {
    analyticsResolutionFoundAtOriginal: messages.analyticsResolutionFoundAtOriginal,
    analyticsRoleFilter: messages.analyticsRoleFilter,
    analyticsSameLocationTitle: messages.analyticsSameLocationTitle,
    analyticsSameLocationDescription: messages.analyticsSameLocationDescription,
    analyticsSameLocationEligible: messages.analyticsSameLocationEligible,
    analyticsSameLocationRate: messages.analyticsSameLocationRate,
    analyticsSameLocationRateHidden: messages.analyticsSameLocationRateHidden,
    analyticsSameLocationCountsOnly: messages.analyticsSameLocationCountsOnly,
    analyticsSameLocationOutcomes: messages.analyticsSameLocationOutcomes,
    analyticsSameLocationReporter: messages.analyticsSameLocationReporter,
    analyticsSameLocationOutcomeCounts: messages.analyticsSameLocationOutcomeCounts,
    analyticsSameLocationDateRange: messages.analyticsSameLocationDateRange,
    analyticsSameLocationExport: messages.analyticsSameLocationExport,
    analyticsSameLocationDateRangeValue: messages.analyticsSameLocationDateRangeValue,
  };
}

const customCopy: Record<Locale, PdfCopy> = {
  en: {
    reportTitle: "Short-Pick Exception Analytics", generated: "Generated", reportScope: "Report scope", reportScopeDescription: "The filters and data boundary used for this export.", allFilters: "All available analytics data", kpiSummary: "KPI summary", kpiSummaryDescription: "Operational volume and working-time measures for the selected period. Timing metrics count working time under each case's pinned schedule (default Mon–Fri 08:00–17:00 Europe/Amsterdam; custom schedules vary per case).", selectedCharts: "Selected charts", selectedChartsDescription: "Counts are shown for the highest-volume categories in this report.", lineOutcomes: "Line outcomes", repeatedOrders: "Repeated order numbers", repeatedSummary: (count) => `${count} order numbers appeared more than once.`, duplicateLimit: (shown, total) => `Showing ${shown} of ${total} groups returned by the analytics limit.`, noDuplicates: "No repeated order numbers in the selected period.", caseDetail: "Case detail", casesIncluded: (shown, total, limited) => `${shown} of ${total} cases included${limited ? " (analytics limit applied)" : ""}, with pagination for longer exports.`, lineDetail: "Short-pick line detail", linesIncluded: (shown, total, limited) => `${shown} of ${total} lines included${limited ? " (analytics limit applied)" : ""}.`, configurationContext: "Configuration context", configurationDescription: "Configuration versions are retained with each case so report results remain auditable.", configurationUnavailable: "Configuration version counts were not returned for this selection.", noCases: "No cases matched the selected filters.", noLines: "No lines matched the selected filters.", order: "Order", phase: "Phase", source: "Source", lines: "Lines", created: "Created", resolved: "Resolved", location: "Location", sku: "SKU", quantity: "Qty", state: "State", resolution: "Resolution", configurationVersion: "Configuration version", cases: "Cases", occurrence: "Occurrences", caseDates: "Case dates", na: "N/A", pagination: "Pagination", page: "Page", omittedDates: (count) => `${count} dates omitted`, analyticsResolutionFoundAtOriginal: "Found at original location", analyticsRoleFilter: "Role", analyticsSameLocationTitle: "Same-location-found", analyticsSameLocationDescription: "Counts are shown for every user; the rate appears only with 20 or more eligible lines. No rankings.", analyticsSameLocationEligible: "Found at original / eligible lines", analyticsSameLocationRate: "Same-location rate", analyticsSameLocationRateHidden: "Rate hidden: fewer than 20 eligible lines", analyticsSameLocationCountsOnly: "counts only", analyticsSameLocationOutcomes: "FOUND_AT_ORIGINAL / FOUND / NOT_FOUND / WRONG_LOCATION", analyticsSameLocationReporter: "Reporter", analyticsSameLocationOutcomeCounts: "Outcome counts", analyticsSameLocationDateRange: "Date range", analyticsSameLocationExport: "Export per-user CSV"
  },
  nl: {
    reportTitle: "Analyses van short-pick-uitzonderingen", generated: "Gegenereerd", reportScope: "Rapportbereik", reportScopeDescription: "De filters en gegevensgrens voor deze export.", allFilters: "Alle beschikbare analysegegevens", kpiSummary: "Kerncijfers", kpiSummaryDescription: "Operationele aantallen en werktijd voor de geselecteerde periode. Timingcijfers tellen werktijd onder het vastgelegde schema van elke case (standaard ma–vr 08:00–17:00 Europe/Amsterdam; aangepaste schema's verschillen per case).", selectedCharts: "Geselecteerde grafieken", selectedChartsDescription: "De hoogste aantallen in dit rapport worden getoond.", lineOutcomes: "Resultaten van regels", repeatedOrders: "Terugkerende ordernummers", repeatedSummary: (count) => `${count} ordernummers kwamen meer dan één keer voor.`, duplicateLimit: (shown, total) => `Er worden ${shown} van ${total} groepen getoond volgens de analyselimiet.`, noDuplicates: "Geen terugkerende ordernummers in de geselecteerde periode.", caseDetail: "Casedetails", casesIncluded: (shown, total, limited) => `${shown} van ${total} cases opgenomen${limited ? " (analyselimiet toegepast)" : ""}; langere exports zijn gepagineerd.`, lineDetail: "Details van short-pick-regels", linesIncluded: (shown, total, limited) => `${shown} van ${total} regels opgenomen${limited ? " (analyselimiet toegepast)" : ""}.`, configurationContext: "Configuratiecontext", configurationDescription: "Configuratieversies worden per case bewaard zodat resultaten controleerbaar blijven.", configurationUnavailable: "Voor deze selectie zijn geen configuratieversies teruggegeven.", noCases: "Geen cases gevonden voor de geselecteerde filters.", noLines: "Geen regels gevonden voor de geselecteerde filters.", order: "Order", phase: "Casefase", source: "Bron", lines: "Regels", created: "Aangemaakt", resolved: "Opgelost", location: "Locatie", sku: "SKU", quantity: "Aantal", state: "Status", resolution: "Oplossing", configurationVersion: "Configuratieversie", cases: "Cases", occurrence: "Voorkomens", caseDates: "Casedatums", na: "Geen gegevens", pagination: "Paginering", page: "Pagina", omittedDates: (count) => `${count} datums weggelaten`, analyticsResolutionFoundAtOriginal: "Gevonden op oorspronkelijke locatie", analyticsRoleFilter: "Rol", analyticsSameLocationTitle: "Gevonden op dezelfde locatie", analyticsSameLocationDescription: "Aantallen worden voor elke gebruiker getoond; het percentage verschijnt alleen bij 20 of meer geschikte regels. Geen ranglijsten.", analyticsSameLocationEligible: "Gevonden op oorspronkelijke locatie / geschikte regels", analyticsSameLocationRate: "Percentage oorspronkelijke locatie", analyticsSameLocationRateHidden: "Percentage verborgen: minder dan 20 geschikte regels", analyticsSameLocationCountsOnly: "alleen aantallen", analyticsSameLocationOutcomes: "FOUND_AT_ORIGINAL / FOUND / NOT_FOUND / WRONG_LOCATION", analyticsSameLocationReporter: "Melder", analyticsSameLocationOutcomeCounts: "Aantallen per resultaat", analyticsSameLocationDateRange: "Datumbereik", analyticsSameLocationExport: "CSV per gebruiker exporteren"
  },
  pl: {
    reportTitle: "Analiza wyjątków short pick", generated: "Wygenerowano", reportScope: "Zakres raportu", reportScopeDescription: "Filtry i zakres danych użyte w eksporcie.", allFilters: "Wszystkie dostępne dane analityczne", kpiSummary: "Podsumowanie KPI", kpiSummaryDescription: "Liczby operacyjne i czas pracy dla wybranego okresu. Wskaźniki czasu liczą godziny pracy według przypiętego harmonogramu sprawy (domyślnie pn–pt 08:00–17:00 Europe/Amsterdam; harmonogramy własne różnią się w zależności od sprawy).", selectedCharts: "Wybrane wykresy", selectedChartsDescription: "Pokazano kategorie o największej liczbie w tym raporcie.", lineOutcomes: "Wyniki pozycji", repeatedOrders: "Powtarzające się numery zamówień", repeatedSummary: (count) => `${count} numerów zamówień pojawiło się więcej niż raz.`, duplicateLimit: (shown, total) => `Pokazano ${shown} z ${total} grup zgodnie z limitem analityki.`, noDuplicates: "Brak powtarzających się numerów zamówień w wybranym okresie.", caseDetail: "Szczegóły spraw", casesIncluded: (shown, total, limited) => `Uwzględniono ${shown} z ${total} spraw${limited ? " (zastosowano limit analityki)" : ""}; dłuższe eksporty mają podział na strony.`, lineDetail: "Szczegóły brakujących pozycji", linesIncluded: (shown, total, limited) => `Uwzględniono ${shown} z ${total} pozycji${limited ? " (zastosowano limit analityki)" : ""}.`, configurationContext: "Kontekst konfiguracji", configurationDescription: "Wersje konfiguracji są zapisywane przy każdej sprawie, aby wyniki można było sprawdzić.", configurationUnavailable: "Dla tego wyboru nie zwrócono wersji konfiguracji.", noCases: "Brak spraw pasujących do wybranych filtrów.", noLines: "Brak pozycji pasujących do wybranych filtrów.", order: "Zamówienie", phase: "Faza", source: "Źródło", lines: "Pozycje", created: "Utworzono", resolved: "Rozwiązano", location: "Lokalizacja", sku: "SKU", quantity: "Ilość", state: "Stan", resolution: "Rozwiązanie", configurationVersion: "Wersja konfiguracji", cases: "Sprawy", occurrence: "Wystąpienia", caseDates: "Daty spraw", na: "Brak danych", pagination: "Paginacja", page: "Strona", omittedDates: (count) => `Pominięto ${count} dat`, analyticsResolutionFoundAtOriginal: "Znaleziono w pierwotnej lokalizacji", analyticsRoleFilter: "Rola", analyticsSameLocationTitle: "Odnalezione w pierwotnej lokalizacji", analyticsSameLocationDescription: "Liczby są pokazywane dla każdego użytkownika; odsetek pojawia się tylko przy co najmniej 20 kwalifikujących się pozycjach. Bez rankingów.", analyticsSameLocationEligible: "Znalezione w pierwotnej lokalizacji / kwalifikujące się pozycje", analyticsSameLocationRate: "Odsetek pierwotnej lokalizacji", analyticsSameLocationRateHidden: "Odsetek ukryty: mniej niż 20 kwalifikujących się pozycji", analyticsSameLocationCountsOnly: "tylko liczby", analyticsSameLocationOutcomes: "FOUND_AT_ORIGINAL / FOUND / NOT_FOUND / WRONG_LOCATION", analyticsSameLocationReporter: "Zgłaszający", analyticsSameLocationOutcomeCounts: "Liczby według wyników", analyticsSameLocationDateRange: "Zakres dat", analyticsSameLocationExport: "Eksportuj CSV według użytkowników"
  },
  es: {
    reportTitle: "Analítica de excepciones de short pick", generated: "Generado", reportScope: "Alcance del informe", reportScopeDescription: "Filtros y límite de datos usados para esta exportación.", allFilters: "Todos los datos analíticos disponibles", kpiSummary: "Resumen de indicadores", kpiSummaryDescription: "Volumen operativo y tiempo laboral del periodo seleccionado. Los indicadores de tiempo cuentan horas laborables según el horario fijado de cada caso (predeterminado lun–vie 08:00–17:00 Europe/Amsterdam; los horarios personalizados varían por caso).", selectedCharts: "Gráficos seleccionados", selectedChartsDescription: "Se muestran las categorías con más volumen del informe.", lineOutcomes: "Resultados de las líneas", repeatedOrders: "Números de pedido recurrentes", repeatedSummary: (count) => `${count} números de pedido aparecieron más de una vez.`, duplicateLimit: (shown, total) => `Se muestran ${shown} de ${total} grupos por el límite de analítica.`, noDuplicates: "No hay números de pedido recurrentes en el periodo seleccionado.", caseDetail: "Detalle de casos", casesIncluded: (shown, total, limited) => `Se incluyen ${shown} de ${total} casos${limited ? " (se aplicó el límite de analítica)" : ""}; las exportaciones largas tienen paginación.`, lineDetail: "Detalle de líneas de short pick", linesIncluded: (shown, total, limited) => `Se incluyen ${shown} de ${total} líneas${limited ? " (se aplicó el límite de analítica)" : ""}.`, configurationContext: "Contexto de configuración", configurationDescription: "Las versiones de configuración se conservan con cada caso para poder auditar los resultados.", configurationUnavailable: "No se devolvieron versiones de configuración para esta selección.", noCases: "No hay casos que coincidan con los filtros seleccionados.", noLines: "No hay líneas que coincidan con los filtros seleccionados.", order: "Pedido", phase: "Fase", source: "Origen", lines: "Líneas", created: "Creado", resolved: "Resuelto", location: "Ubicación", sku: "SKU", quantity: "Cant.", state: "Estado", resolution: "Resolución", configurationVersion: "Versión de configuración", cases: "Casos", occurrence: "Ocurrencias", caseDates: "Fechas de casos", na: "Sin datos", pagination: "Paginación", page: "Página", omittedDates: (count) => `${count} fechas omitidas`, analyticsResolutionFoundAtOriginal: "Encontrado en la ubicación original", analyticsRoleFilter: "Rol", analyticsSameLocationTitle: "Encontrados en la ubicación original", analyticsSameLocationDescription: "Los recuentos se muestran para cada usuario; la tasa aparece solo con 20 o más líneas elegibles. Sin clasificaciones.", analyticsSameLocationEligible: "Encontrados en ubicación original / líneas elegibles", analyticsSameLocationRate: "Tasa de ubicación original", analyticsSameLocationRateHidden: "Tasa oculta: menos de 20 líneas elegibles", analyticsSameLocationCountsOnly: "solo recuentos", analyticsSameLocationOutcomes: "FOUND_AT_ORIGINAL / FOUND / NOT_FOUND / WRONG_LOCATION", analyticsSameLocationReporter: "Informante", analyticsSameLocationOutcomeCounts: "Recuentos por resultado", analyticsSameLocationDateRange: "Intervalo de fechas", analyticsSameLocationExport: "Exportar CSV por usuario"
  },
};

export function normalizePdfLocale(language: string | undefined): Locale {
  return language === "nl" || language === "pl" || language === "es" ? language : "en";
}

export function getPdfCopy(language: string | undefined): PdfLabels {
  const locale = normalizePdfLocale(language);
  const messages = getMessages(locale).messages;
  const copy = customCopy[locale];
  const sameLocation = sameLocationDictCopy(messages);
  return Object.assign({}, ANALYTICS_PDF_FALLBACK_COPY, copy, sameLocation, { analyticsFrom: messages.analyticsFrom, analyticsTo: messages.analyticsTo, orderNumber: messages.orderNumber, location: messages.location, sku: messages.sku, analyticsPhase: messages.analyticsPhase, analyticsResolution: messages.analyticsResolution, analyticsSource: messages.analyticsSource, analyticsConfiguration: messages.analyticsConfiguration, analyticsPicker: messages.analyticsPicker, analyticsChecker: messages.analyticsChecker, analyticsTroubleshooter: messages.analyticsTroubleshooter, analyticsTotalCases: messages.analyticsTotalCases, analyticsTotalLines: messages.analyticsTotalLines, analyticsFound: messages.analyticsFound, analyticsNotFound: messages.analyticsNotFound, analyticsWrongLocation: messages.analyticsWrongLocation, analyticsRetrieved: messages.analyticsRetrieved, analyticsOverThreshold: messages.analyticsOverThreshold, analyticsManualCases: messages.analyticsManualCases, analyticsReopenedCases: messages.analyticsReopenedCases, analyticsRepeatedOrders: messages.analyticsRepeatedOrders, analyticsReportToClaim: messages.analyticsReportToClaim, analyticsReportToFound: messages.analyticsReportToFound, analyticsReportToRetrieval: messages.analyticsReportToRetrieval, analyticsReportToResolution: messages.analyticsReportToResolution, analyticsLinesByLocation: messages.analyticsLinesByLocation, analyticsLinesBySku: messages.analyticsLinesBySku, analyticsPhasePicking: messages.analyticsPhasePicking, analyticsPhaseStaged: messages.analyticsPhaseStaged, analyticsPhaseClosed: messages.analyticsPhaseClosed, analyticsResolutionFound: messages.analyticsResolutionFound, analyticsResolutionNotFound: messages.analyticsResolutionNotFound, analyticsResolutionWrongLocation: messages.analyticsResolutionWrongLocation, analyticsResolutionOther: messages.analyticsResolutionOther, analyticsSourcePickerReport: messages.analyticsSourcePickerReport, analyticsSourceTlManual: messages.analyticsSourceTlManual, analyticsSourceAssistantManual: messages.analyticsSourceAssistantManual, analyticsSourceAdminManual: messages.analyticsSourceAdminManual, caseOpen: messages.caseOpen, caseChecking: messages.caseChecking, caseFound: messages.caseFound, caseRetrieved: messages.caseRetrieved, caseClosed: messages.caseClosed, caseCancelled: messages.caseCancelled });
}

function asString(value: unknown, fallback = "-") {
  if (value === null || value === undefined || value === "") return fallback;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function asNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function field(row: Record<string, unknown>, ...names: string[]) {
  for (const name of names) if (row[name] !== undefined && row[name] !== null) return row[name];
  return undefined;
}

const intlLocales: Record<Locale, string> = { en: "en-GB", nl: "nl-NL", pl: "pl-PL", es: "es-ES" };

function dateLabel(value: unknown, locale: Locale) {
  if (!value) return "-";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return asString(value);
  return new Intl.DateTimeFormat(intlLocales[locale], { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date);
}

function shortDate(value: unknown, locale: Locale) {
  if (!value) return "-";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return asString(value);
  return new Intl.DateTimeFormat(intlLocales[locale], { dateStyle: "medium", timeZone: "UTC" }).format(date);
}

export function selectPdfFilters(filters: Record<string, unknown>) {
  return Object.fromEntries(ACTIVE_FILTER_KEYS.filter((key) => filters[key] !== undefined && filters[key] !== "").map((key) => [key, filters[key]]));
}

function enumLabel(key: string, value: unknown, labels: PdfLabels) {
  const stringValue = asString(value);
  if (key === "phase") return ({ PICKING: labels.analyticsPhasePicking, STAGED: labels.analyticsPhaseStaged, CLOSED: labels.analyticsPhaseClosed } as Record<string, string>)[stringValue] ?? stringValue;
  if (key === "state") return ({ OPEN: labels.caseOpen, CHECKING: labels.caseChecking, FOUND: labels.caseFound, RETRIEVING: labels.caseRetrieved, RESOLVED: labels.caseClosed, CANCELLED: labels.caseCancelled } as Record<string, string>)[stringValue] ?? stringValue;
  if (key === "resolution") return ({ FOUND: labels.analyticsResolutionFound, NOT_FOUND: labels.analyticsResolutionNotFound, WRONG_LOCATION: labels.analyticsResolutionWrongLocation, OTHER: labels.analyticsResolutionOther, FOUND_AT_ORIGINAL: labels.analyticsResolutionFoundAtOriginal } as Record<string, string>)[stringValue] ?? stringValue;
  if (key === "source") return ({ PICKER_REPORT: labels.analyticsSourcePickerReport, TL_MANUAL: labels.analyticsSourceTlManual, ASSISTANT_MANUAL: labels.analyticsSourceAssistantManual, MANAGER_MANUAL: labels.analyticsSourceManagerManual, ADMIN_MANUAL: labels.analyticsSourceAdminManual } as Record<string, string>)[stringValue] ?? stringValue;
  return stringValue;
}

function labelForFilter(key: string, labels: PdfLabels) {
  return ({ from: labels.analyticsFrom, to: labels.analyticsTo, orderNumber: labels.orderNumber, location: labels.location, sku: labels.sku, phase: labels.analyticsPhase, resolution: labels.analyticsResolution, source: labels.analyticsSource, configVersion: labels.analyticsConfiguration, pickerUserId: labels.analyticsPicker, checkerUserId: labels.analyticsChecker, troubleshooterUserId: labels.analyticsTroubleshooter, role: labels.analyticsRoleFilter } as Record<string, string>)[key] ?? key;
}

function pairs(value: unknown): Array<[string, number]> {
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => {
      if (Array.isArray(entry)) return [asString(entry[0]), asNumber(entry[1])];
      if (entry && typeof entry === "object") {
        const item = entry as Record<string, unknown>;
        return [asString(field(item, "label", "key", "name", "location", "sku", "period", "version")), asNumber(field(item, "count", "value", "total", "lines", "cases"))];
      }
      return [asString(entry), 0];
    });
  }
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>).slice(0, 20).map(([key, count]) => [key, asNumber(count)]);
  return [];
}

export function analyticsDimensionPairs(value: unknown): Array<[string, number]> {
  return pairs(value);
}

function textForMetric(key: string, value: unknown, labels: PdfLabels, locale: Locale) {
  if (value === null || value === undefined) return labels.na;
  const seconds = ["medianReportToCheckClaimedSeconds", "medianReportToLocationFoundSeconds", "medianReportToRetrievalSeconds", "medianReportToResolutionSeconds"].includes(key);
  if (seconds && asNumber(value) > 0) {
    const total = Math.round(asNumber(value));
    const units = locale === "nl" ? ["uur", "min", "sec"] : locale === "pl" ? ["godz.", "min", "s"] : locale === "es" ? ["h", "min", "s"] : ["h", "m", "s"];
    if (total >= 3600) return `${Math.floor(total / 3600)}${units[0]} ${Math.floor((total % 3600) / 60)}${units[1]}`;
    if (total >= 60) return `${Math.floor(total / 60)}${units[1]} ${total % 60}${units[2]}`;
    return `${total}${units[2]}`;
  }
  return asNumber(value).toLocaleString(intlLocales[locale]);
}

export function formatAnalyticsMetric(key: string, value: unknown) {
  return textForMetric(key, value, getPdfCopy("en"), "en");
}

function metricLabel(key: string, labels: PdfLabels) {
  return ({ totalCases: labels.analyticsTotalCases, totalLines: labels.analyticsTotalLines, foundDuringCheck: labels.analyticsFound, notFound: labels.analyticsNotFound, wrongLocation: labels.analyticsWrongLocation, retrieved: labels.analyticsRetrieved, casesOverThreshold: labels.analyticsOverThreshold, manualCases: labels.analyticsManualCases, reopenedCases: labels.analyticsReopenedCases, repeatedOrderNumbers: labels.analyticsRepeatedOrders, medianReportToCheckClaimedSeconds: labels.analyticsReportToClaim, medianReportToLocationFoundSeconds: labels.analyticsReportToFound, medianReportToRetrievalSeconds: labels.analyticsReportToRetrieval, medianReportToResolutionSeconds: labels.analyticsReportToResolution } as Record<string, string>)[key] ?? key;
}

function drawSection(doc: PDFKit.PDFDocument, title: string, subtitle?: string) {
  if (doc.y > PAGE_HEIGHT - MARGIN - FOOTER_HEIGHT - 80) doc.addPage();
  doc.moveDown(0.8);
  doc.fillColor(BRAND).rect(MARGIN, doc.y, 4, 18).fill();
  doc.fillColor(INK).font(REPORT_BOLD).fontSize(13).text(title, MARGIN + 12, doc.y + 1);
  if (subtitle) doc.fillColor(MUTED).font(REPORT_REGULAR).fontSize(8.5).text(subtitle, MARGIN + 12, doc.y + 19, { width: CONTENT_WIDTH - 12 });
  doc.moveDown(subtitle ? 1.8 : 1.2);
}

function drawKeyValueGrid(doc: PDFKit.PDFDocument, values: Array<[string, string]>) {
  const columns = 2;
  const gap = 12;
  const width = (CONTENT_WIDTH - gap) / columns;
  let y = doc.y;
  for (let index = 0; index < values.length; index += columns) {
    const row = values.slice(index, index + columns);
    const heights = row.map(([, value]) => {
      doc.font(REPORT_REGULAR).fontSize(9);
      const height = Math.max(doc.heightOfString(value, { width: width - 22 }), 13);
      return Math.max(31, height + 22);
    });
    const height = Math.max(...heights);
    if (y + height > PAGE_HEIGHT - MARGIN - FOOTER_HEIGHT) {
      doc.addPage();
      y = doc.y;
    }
    row.forEach(([key, value], column) => {
      const x = MARGIN + column * (width + gap);
      doc.fillColor("#f8fafc").roundedRect(x, y, width, height, 4).fill();
      doc.fillColor(MUTED).font(REPORT_BOLD).fontSize(7.5).text(key.toUpperCase(), x + 10, y + 8, { width: width - 20 });
      doc.fillColor(INK).font(REPORT_REGULAR).fontSize(9).text(value, x + 10, y + 20, { width: width - 20, height: height - 22, ellipsis: true });
    });
    y += height + 7;
  }
  doc.y = y;
}

function drawBarChart(doc: PDFKit.PDFDocument, title: string, values: Array<[string, number]>, locale: Locale) {
  if (!values.length) return;
  if (doc.y > PAGE_HEIGHT - MARGIN - FOOTER_HEIGHT - 180) doc.addPage();
  const chartY = doc.y + 18;
  const max = Math.max(...values.map(([, count]) => count), 1);
  doc.fillColor(INK).font(REPORT_BOLD).fontSize(9.5).text(title, MARGIN, doc.y);
  const chartWidth = CONTENT_WIDTH - 40;
  values.slice(0, 8).forEach(([label, count], index) => {
    const barWidth = Math.max(2, (count / max) * (chartWidth - 157));
    const y = chartY + index * 13;
    doc.fillColor(MUTED).font(REPORT_REGULAR).fontSize(7).text(label, MARGIN, y + 1, { width: 145, height: 9, ellipsis: true, lineBreak: false });
    doc.fillColor("#e2e8f0").roundedRect(MARGIN + 151, y, chartWidth - 157, 9, 2).fill();
    doc.fillColor(BRAND).roundedRect(MARGIN + 151, y, barWidth, 9, 2).fill();
    doc.fillColor(INK).font(REPORT_BOLD).fontSize(7).text(count.toLocaleString(intlLocales[locale]), MARGIN + 156 + barWidth, y + 1, { width: 38 });
  });
  doc.y = chartY + Math.min(values.length, 8) * 13 + 12;
}

type SameLocationUserRow = { role?: unknown; from?: unknown; to?: unknown; displayName?: unknown; numerator?: unknown; denominator?: unknown; percentage?: unknown; counts?: Record<string, unknown> };

function drawSameLocationGrid(doc: PDFKit.PDFDocument, value: unknown, users: unknown, labels: PdfLabels, locale: Locale) {
  if (!value || typeof value !== "object") return;
  const tr = (key: MessageKey, values?: Record<string, string>) => translate(getMessages(locale).messages, key, values);
  const summary = value as { numerator?: unknown; denominator?: unknown; percentage?: unknown; counts?: Record<string, unknown>; from?: unknown; to?: unknown };
  const counts = summary.counts ?? {};
  const count = (value: unknown) => asNumber(value).toLocaleString(intlLocales[locale]);
  const rate = (value: unknown) => typeof value === "number" ? new Intl.NumberFormat(intlLocales[locale], { style: "percent", maximumFractionDigits: 1 }).format(value / 100) : "—*";
  const range = (from: unknown, to: unknown) => {
    const end = new Date(asString(to));
    return tr("analyticsSameLocationDateRangeValue", { from: shortDate(from, locale), to: shortDate(Number.isFinite(end.valueOf()) ? new Date(end.valueOf() - 1).toISOString() : to, locale) });
  };
  if (doc.y > PAGE_HEIGHT - MARGIN - FOOTER_HEIGHT - 300) doc.addPage();
  drawSection(doc, tr("analyticsSameLocationTitle"), `${tr("analyticsSameLocationDescription")} ${tr("analyticsSameLocationScope")}`);
  doc.fillColor(MUTED).font(REPORT_REGULAR).fontSize(8).text(range(summary.from, summary.to));
  doc.moveDown(.6);
  drawTable(doc, [{ key: "metric", label: tr("managementMeasure"), width: 280 }, { key: "value", label: tr("managementValue"), width: CONTENT_WIDTH - 280 }], [
    { metric: tr("analyticsSameLocationFoundCount"), value: count(summary.numerator) },
    { metric: tr("analyticsSameLocationEligible"), value: count(summary.denominator) },
    { metric: tr("analyticsSameLocationRate"), value: rate(summary.percentage) },
    { metric: tr("analyticsSameLocationElsewhere"), value: count(counts.FOUND) },
    { metric: labels.analyticsNotFound, value: count(counts.NOT_FOUND) },
    { metric: labels.analyticsWrongLocation, value: count(counts.WRONG_LOCATION) },
  ]);
  const rows = (Array.isArray(users) ? users : []) as Array<SameLocationUserRow>;
  const staff = rows.filter((row) => typeof row.role !== "string" || isSameLocationReporter(row.role));
  const drawRateFootnote = () => {
    if (typeof summary.percentage === "number" && staff.every((row) => typeof row.percentage === "number")) return;
    if (doc.y > PAGE_HEIGHT - MARGIN - FOOTER_HEIGHT - 35) doc.addPage();
    doc.fillColor(MUTED).font(REPORT_REGULAR).fontSize(8).text(`* ${tr("analyticsSameLocationCountsOnly")}`);
    doc.moveDown(.6);
  };
  if (!staff.length) { drawRateFootnote(); return; }
  if (doc.y > PAGE_HEIGHT - MARGIN - FOOTER_HEIGHT - 240) doc.addPage();
  drawSection(doc, tr("analyticsSameLocationByReporter"), tr("analyticsSameLocationReporterNote"));
  drawTable(doc, [
    { key: "reporter", label: tr("analyticsSameLocationReporter"), width: 150 },
    { key: "checked", label: tr("analyticsSameLocationEligible"), width: 55 },
    { key: "original", label: tr("analyticsSameLocationFoundCount"), width: 65 },
    { key: "rate", label: tr("analyticsSameLocationRate"), width: 80 },
    { key: "other", label: tr("analyticsSameLocationOutcomes"), width: CONTENT_WIDTH - 350 },
  ], staff.slice(0, MAX_RENDER_ROWS).map((row) => {
    const rowCounts = row.counts ?? {};
    return { reporter: asString(row.displayName), checked: count(row.denominator), original: count(row.numerator), rate: rate(row.percentage),
      other: `${tr("analyticsSameLocationElsewhere")}: ${count(rowCounts.FOUND)}\n${labels.analyticsNotFound}: ${count(rowCounts.NOT_FOUND)}\n${labels.analyticsWrongLocation}: ${count(rowCounts.WRONG_LOCATION)}` };
  }));
  drawRateFootnote();
}

function drawTable(doc: PDFKit.PDFDocument, columns: Array<{ key: string; label: string; width: number }>, rows: Array<Record<string, unknown>>) {
  const drawHeader = () => {
    doc.font(REPORT_BOLD).fontSize(7);
    const headerHeight = Math.max(20, ...columns.map((column) => doc.heightOfString(column.label, { width: column.width - 12 }) + 12));
    if (doc.y + headerHeight > PAGE_HEIGHT - MARGIN - FOOTER_HEIGHT) doc.addPage();
    const y = doc.y;
    doc.fillColor(BRAND).rect(MARGIN, y, CONTENT_WIDTH, headerHeight).fill();
    let x = MARGIN;
    columns.forEach((column) => {
      doc.fillColor("#ffffff").font(REPORT_BOLD).fontSize(7).text(column.label, x + 6, y + 6, { width: column.width - 12, ellipsis: true });
      x += column.width;
    });
    doc.y = y + headerHeight;
  };
  if (doc.y > PAGE_HEIGHT - MARGIN - FOOTER_HEIGHT - 80) doc.addPage();
  drawHeader();
  rows.slice(0, MAX_RENDER_ROWS).forEach((row, rowIndex) => {
    const values = columns.map((column) => asString(row[column.key]));
    doc.font(REPORT_REGULAR).fontSize(7.4);
    const heights = values.map((value, index) => Math.max(21, doc.heightOfString(value, { width: columns[index]!.width - 12 }) + 10));
    const height = Math.max(...heights);
    if (doc.y + height > PAGE_HEIGHT - MARGIN - FOOTER_HEIGHT) {
      doc.addPage();
      drawHeader();
    }
    const y = doc.y;
    if (rowIndex % 2 === 0) doc.fillColor(ALT_ROW).rect(MARGIN, y, CONTENT_WIDTH, height).fill();
    let x = MARGIN;
    columns.forEach((column, index) => {
      doc.fillColor(INK).font(REPORT_REGULAR).fontSize(7.4).text(values[index]!, x + 6, y + 5, { width: column.width - 12, height: height - 8, ellipsis: true });
      x += column.width;
    });
    doc.strokeColor(RULE).lineWidth(0.35).moveTo(MARGIN, y + height).lineTo(MARGIN + CONTENT_WIDTH, y + height).stroke();
    doc.y = y + height;
  });
}

function normalizeCaseRows(rows: Array<Record<string, unknown>>, locale: Locale, labels: PdfLabels) {
  return rows.slice(0, MAX_RENDER_ROWS).map((row) => ({
    order: asString(field(row, "orderNumber", "order")),
    phase: enumLabel("phase", row.phase, labels),
    source: enumLabel("source", row.source, labels),
    lines: asString(field(row, "lineCount", "totalLines", "lines")),
    created: shortDate(field(row, "createdAt", "reportedAt"), locale),
    resolved: shortDate(field(row, "resolvedAt", "resolutionAt"), locale),
  }));
}

function normalizeLineRows(rows: Array<Record<string, unknown>>, locale: Locale, labels: PdfLabels) {
  return rows.slice(0, MAX_RENDER_ROWS).map((row) => ({
    order: asString(field(row, "orderNumber", "order")),
    location: asString(field(row, "location", "originalLocation")),
    sku: asString(row.sku),
    qty: asString(field(row, "missingQuantity", "quantity")),
    state: enumLabel("state", row.state, labels),
    resolution: enumLabel("resolution", field(row, "resolutionCode", "resolution"), labels),
  }));
}

function duplicateRows(orders: Array<Record<string, unknown>>, locale: Locale, labels: PdfLabels) {
  const result: Array<Record<string, unknown>> = [];
  let remainingRows = MAX_DUPLICATE_DATE_ROWS;
  let orderIndex = 0;
  for (; orderIndex < Math.min(orders.length, MAX_RENDER_ROWS) && remainingRows > 0; orderIndex++) {
    const entry = orders[orderIndex]!;
    const cases = Array.isArray(entry.cases) ? (entry.cases as Array<Record<string, unknown>>) : [];
    const maxDatesForOrder = Math.min(cases.length, remainingRows * 8);
    const chunks: Array<Array<Record<string, unknown>>> = [];
    for (let index = 0; index < maxDatesForOrder; index += 8) chunks.push(cases.slice(index, index + 8));
    if (!chunks.length) chunks.push([]);
    chunks.forEach((chunk, index) => {
      const shown = Math.min((index + 1) * 8, cases.length, maxDatesForOrder);
      const omitted = Math.max(cases.length - shown, 0);
      const dates = chunk.map((item) => shortDate(item.createdAt, locale));
      if (omitted && index === chunks.length - 1) dates.push(labels.omittedDates(omitted.toLocaleString(intlLocales[locale])));
      result.push({ orderNumber: index === 0 ? asString(entry.orderNumber) : "", occurrences: index === 0 ? asString(entry.occurrences) : "", dates: dates.join(", ") || labels.na });
    });
    remainingRows -= chunks.length;
  }
  const omittedOrders = orders.slice(orderIndex);
  const omittedOccurrences = omittedOrders.reduce((total, entry) => total + (Array.isArray(entry.cases) ? entry.cases.length : 0), 0);
  if (omittedOccurrences > 0) result.push({ orderNumber: "", occurrences: "", dates: labels.omittedDates(omittedOccurrences.toLocaleString(intlLocales[locale])) });
  return result;
}

/** Create a bounded, deliberate report layout and resolve it to a PDF byte array. */
function drawManagement(doc: PDFKit.PDFDocument, data: AnalyticsManagement, locale: Locale) {
  const messages = getMessages(locale).messages;
  const tr = (key: MessageKey, values?: Record<string, string>) => translate(messages, key, values);
  const count = (value: number) => value.toLocaleString(intlLocales[locale]);
  const { comparison, backlog, lifetimeRecurrence } = data;
  const range = (period: PeriodTotals) => `${shortDate(period.from, locale)} – ${shortDate(new Date(new Date(period.toExclusive).valueOf() - 1).toISOString(), locale)}`;
  if (doc.y > PAGE_HEIGHT - MARGIN - FOOTER_HEIGHT - 240) doc.addPage();
  drawSection(doc, tr("managementComparisonTitle"), tr("managementComparisonNote"));
  doc.fillColor(MUTED).font(REPORT_REGULAR).fontSize(8).text(tr("managementCurrentPeriod", { range: range(comparison.current) }));
  doc.text(tr("managementPreviousPeriod", { range: range(comparison.previous) }));
  doc.moveDown(.8);
  const comparisonRows = (["cases", "lines", "resolvedCases"] as const).map((metric) => {
    const change = comparison.changes[metric];
    const label: MessageKey = metric === "cases" ? "managementReportedCases" : metric === "lines" ? "managementCohortLines" : "managementCasesResolved";
    const percentage = change.delta === 0 ? tr("managementChangeNoChange") : change.percentage === null ? tr("managementChangeNoBaseline")
      : new Intl.NumberFormat(intlLocales[locale], { style: "percent", maximumFractionDigits: 1, signDisplay: "exceptZero" }).format(change.percentage / 100);
    return { metric: tr(label), current: count(change.current), previous: count(change.previous), change: `${new Intl.NumberFormat(intlLocales[locale], { signDisplay: "exceptZero" }).format(change.delta)} / ${percentage}` };
  });
  drawTable(doc, [{ key: "metric", label: tr("managementMeasure"), width: 170 }, { key: "current", label: tr("managementCurrentValue"), width: 65 },
    { key: "previous", label: tr("managementPreviousValue"), width: 80 }, { key: "change", label: tr("managementChangeValue"), width: CONTENT_WIDTH - 315 }], comparisonRows);
  if (doc.y > PAGE_HEIGHT - MARGIN - FOOTER_HEIGHT - 340) doc.addPage();
  drawSection(doc, tr("managementBacklogTitle"), `${tr("managementBacklogNote")} ${tr("managementSnapshot", { at: dateLabel(backlog.asOf, locale) })}`);
  const backlogRows: Array<Record<string, unknown>> = [
    { metric: tr("managementTotalOpen"), value: count(backlog.totalOpen) },
    { metric: tr("managementPicking"), value: count(backlog.picking) },
    { metric: tr("managementStaged"), value: count(backlog.staged) },
    { metric: tr("managementUnassignedStaged"), value: count(backlog.unassignedStaged) },
    { metric: tr("managementOldestReported"), value: shortDate(backlog.oldestCreatedAt, locale) },
  ];
  if (backlog.truncated) {
    backlogRows.push({ metric: tr("managementAgingTitle"), value: tr("managementAgingTruncated", { evaluated: count(backlog.evaluatedCases), total: count(backlog.totalOpen) }) });
  } else {
    for (const [key, value] of [
      ["managementAgingUnder24", backlog.aging.under24h], ["managementAging24to72", backlog.aging.h24to72],
      ["managementAging72to168", backlog.aging.h72to168], ["managementAgingOver168", backlog.aging.over168h], ["managementOverThreshold", backlog.overThreshold],
    ] as const) backlogRows.push({ metric: tr(key), value: count(value) });
  }
  drawTable(doc, [{ key: "metric", label: tr("managementMeasure"), width: 250 }, { key: "value", label: tr("managementValue"), width: CONTENT_WIDTH - 250 }], backlogRows);
  if (doc.y > PAGE_HEIGHT - MARGIN - FOOTER_HEIGHT - 240) doc.addPage();
  drawSection(doc, tr("managementRecurrenceTitle"), `${tr("managementRecurrenceSummary", { count: count(lifetimeRecurrence.repeatedOrderCount) })}. ${tr("managementRecurrenceNote")}`);
  if (lifetimeRecurrence.groupsTruncated || lifetimeRecurrence.datesTruncated) {
    doc.fillColor(MUTED).font(REPORT_REGULAR).fontSize(8).text([
      lifetimeRecurrence.groupsTruncated ? tr("managementRecurrenceGroupsTruncated") : "",
      lifetimeRecurrence.datesTruncated ? tr("managementRecurrenceDatesTruncated") : "",
    ].filter(Boolean).join(" "));
    doc.moveDown(.8);
  }
  if (!lifetimeRecurrence.orders.length) {
    doc.fillColor(MUTED).font(REPORT_REGULAR).fontSize(9).text(tr("managementRecurrenceEmpty"));
    return;
  }
  drawTable(doc, [
    { key: "orderNumber", label: tr("managementColumnOrder"), width: 105 },
    { key: "occurrences", label: tr("managementColumnOccurrences"), width: 80 },
    { key: "selected", label: tr("managementColumnSelectedPeriod"), width: 95 },
    { key: "first", label: tr("managementColumnFirstSeen"), width: 115 },
    { key: "last", label: tr("managementColumnLastSeen"), width: CONTENT_WIDTH - 395 },
  ], lifetimeRecurrence.orders.map((order) => ({ orderNumber: order.orderNumber, occurrences: count(order.occurrences), selected: count(order.selectedPeriodOccurrences), first: shortDate(order.firstSeenAt, locale), last: shortDate(order.lastSeenAt, locale) })));
  drawSection(doc, tr("managementColumnDates"));
  drawTable(doc, [{ key: "orderNumber", label: tr("managementColumnOrder"), width: 180 }, { key: "createdAt", label: tr("managementColumnDates"), width: CONTENT_WIDTH - 180 }],
    lifetimeRecurrence.orders.flatMap((order) => order.cases.map((entry) => ({ orderNumber: order.orderNumber, createdAt: dateLabel(entry.createdAt, locale) }))));
}

export async function renderAnalyticsPdf(data: AnalyticsReportData, options: PdfReportOptions = {}): Promise<Uint8Array> {
  const generatedAt = options.generatedAt ?? new Date();
  const locale = normalizePdfLocale(options.language);
  const labels = getPdfCopy(locale);
  const companyName = options.companyName ?? process.env.WAREHOUSE_COMPANY_NAME ?? "Warehouse Operations";
  const title = options.title ?? labels.reportTitle;
  const chunks: Buffer[] = [];
  const document = new PDFDocument({ size: "A4", margin: MARGIN, bufferPages: true, info: { Title: title, Author: companyName, Subject: "Short-pick exception analytics report" } });
  document.registerFont(REPORT_REGULAR, join(process.cwd(), "public", "fonts", "NotoSans-Regular.ttf"));
  document.registerFont(REPORT_BOLD, join(process.cwd(), "public", "fonts", "NotoSans-Bold.ttf"));
  document.on("data", (chunk: Buffer) => chunks.push(chunk));
  const kpis = data.kpis ?? {};
  const filters = data.filters ?? {};
  const limits = data.limits ?? {};

  document.fillColor(BRAND).font(REPORT_BOLD).fontSize(9).text(companyName.toUpperCase(), MARGIN, MARGIN);
  document.fillColor(INK).font(REPORT_BOLD).fontSize(25).text(title, MARGIN, MARGIN + 19, { width: CONTENT_WIDTH });
  document.fillColor(MUTED).font(REPORT_REGULAR).fontSize(9).text(`${labels.generated} ${dateLabel(generatedAt, locale)} UTC`, MARGIN, MARGIN + 52);
  document.strokeColor(BRAND).lineWidth(1.5).moveTo(MARGIN, MARGIN + 72).lineTo(MARGIN + CONTENT_WIDTH, MARGIN + 72).stroke();
  document.y = MARGIN + 87;

  drawSection(document, labels.reportScope, labels.reportScopeDescription);
  const selectedFilters = selectPdfFilters(filters as Record<string, unknown>);
  const filterValues = Object.entries(selectedFilters).map(([key, value]) => [labelForFilter(key, labels), key === "from" || key === "to" ? dateLabel(value, locale) : enumLabel(key, value, labels)] as [string, string]);
  drawKeyValueGrid(document, filterValues.length ? filterValues : [[labels.analyticsPhase, labels.allFilters]]);

  drawSection(document, labels.kpiSummary, labels.kpiSummaryDescription);
  const metricKeys = ["totalCases", "totalLines", "foundDuringCheck", "notFound", "wrongLocation", "retrieved", "casesOverThreshold", "manualCases", "reopenedCases", "repeatedOrderNumbers", "medianReportToCheckClaimedSeconds", "medianReportToLocationFoundSeconds", "medianReportToRetrievalSeconds", "medianReportToResolutionSeconds"];
  drawKeyValueGrid(document, metricKeys.filter((key) => kpis[key] !== undefined).map((key) => [metricLabel(key, labels), textForMetric(key, kpis[key], labels, locale)]));

  if (document.y > PAGE_HEIGHT - MARGIN - FOOTER_HEIGHT - 320) document.addPage();
  drawSection(document, labels.selectedCharts, labels.selectedChartsDescription);
  drawBarChart(document, labels.analyticsLinesByLocation, pairs(kpis.linesByLocation), locale);
  drawBarChart(document, labels.analyticsLinesBySku, pairs(kpis.linesBySku), locale);
  const outcomePairs: Array<[string, number]> = [[labels.analyticsFound, asNumber(kpis.foundDuringCheck)], [labels.analyticsNotFound, asNumber(kpis.notFound)], [labels.analyticsWrongLocation, asNumber(kpis.wrongLocation)], [labels.analyticsRetrieved, asNumber(kpis.retrieved)]];
  drawBarChart(document, labels.lineOutcomes, outcomePairs, locale);
  drawSameLocationGrid(document, kpis.sameLocationFound, kpis.sameLocationFoundByUser, labels, locale);

  if (data.management) drawManagement(document, data.management, locale);
  else {
  const duplicates = data.duplicates?.orders ?? [];
  const repeatedOrderCount = asNumber(data.duplicates?.repeatedOrderCount ?? kpis.repeatedOrderNumbers);
  const duplicateNote = repeatedOrderCount > duplicates.length ? ` ${labels.duplicateLimit(duplicates.length.toLocaleString(intlLocales[locale]), repeatedOrderCount.toLocaleString(intlLocales[locale]))}` : "";
  drawSection(document, labels.repeatedOrders, `${labels.repeatedSummary(repeatedOrderCount.toLocaleString(intlLocales[locale]))}${duplicateNote}`);
  if (duplicates.length) {
    drawTable(document, [{ key: "orderNumber", label: labels.order, width: 150 }, { key: "occurrences", label: labels.occurrence, width: 80 }, { key: "dates", label: labels.caseDates, width: CONTENT_WIDTH - 230 }], duplicateRows(duplicates, locale, labels));
  } else document.fillColor(MUTED).font(REPORT_REGULAR).fontSize(9).text(labels.noDuplicates);

  }

  const cases = normalizeCaseRows(data.rows?.cases ?? [], locale, labels);
  if (document.y > PAGE_HEIGHT - MARGIN - FOOTER_HEIGHT - 210) document.addPage();
  const caseTotal = asNumber(kpis.totalCases) || cases.length;
  const caseTruncated = cases.length < caseTotal || limits.casesTruncated === true || (asNumber(limits.maxCases) > 0 && caseTotal > asNumber(limits.maxCases));
  drawSection(document, labels.caseDetail, labels.casesIncluded(cases.length.toLocaleString(intlLocales[locale]), caseTotal.toLocaleString(intlLocales[locale]), caseTruncated));
  if (cases.length) drawTable(document, [{ key: "order", label: labels.order, width: 92 }, { key: "phase", label: labels.phase, width: 64 }, { key: "source", label: labels.source, width: 105 }, { key: "lines", label: labels.lines, width: 48 }, { key: "created", label: labels.created, width: 93 }, { key: "resolved", label: labels.resolved, width: CONTENT_WIDTH - 402 }], cases);
  else document.fillColor(MUTED).font(REPORT_REGULAR).fontSize(9).text(labels.noCases);

  const lines = normalizeLineRows(data.rows?.lines ?? [], locale, labels);
  const lineTotal = asNumber(kpis.totalLines) || lines.length;
  const lineTruncated = lines.length < lineTotal || limits.linesTruncated === true || (asNumber(limits.maxLines) > 0 && lineTotal > asNumber(limits.maxLines));
  drawSection(document, labels.lineDetail, labels.linesIncluded(lines.length.toLocaleString(intlLocales[locale]), lineTotal.toLocaleString(intlLocales[locale]), lineTruncated));
  if (lines.length) drawTable(document, [{ key: "order", label: labels.order, width: 82 }, { key: "location", label: labels.location, width: 108 }, { key: "sku", label: labels.sku, width: 114 }, { key: "qty", label: labels.quantity, width: 40 }, { key: "state", label: labels.state, width: 76 }, { key: "resolution", label: labels.resolution, width: CONTENT_WIDTH - 420 }], lines);
  else document.fillColor(MUTED).font(REPORT_REGULAR).fontSize(9).text(labels.noLines);

  drawSection(document, labels.configurationContext, labels.configurationDescription);
  const configurationRows = pairs(kpis.casesByConfigurationVersion).map(([version, count]) => ({ version, cases: count.toLocaleString(intlLocales[locale]) }));
  if (configurationRows.length) drawTable(document, [{ key: "version", label: labels.configurationVersion, width: CONTENT_WIDTH - 100 }, { key: "cases", label: labels.cases, width: 100 }], configurationRows);
  else if (data.configurationContext && typeof data.configurationContext === "object") drawKeyValueGrid(document, Object.entries(data.configurationContext as Record<string, unknown>).map(([key, value]) => [labelForFilter(key, labels), asString(value)]));
  else document.fillColor(MUTED).font(REPORT_REGULAR).fontSize(9).text(labels.configurationUnavailable);

  const range = document.bufferedPageRange();
  for (let page = range.start; page < range.start + range.count; page++) {
    document.switchToPage(page);
    document.strokeColor(RULE).lineWidth(0.5).moveTo(MARGIN, PAGE_HEIGHT - MARGIN - FOOTER_HEIGHT + 4).lineTo(PAGE_WIDTH - MARGIN, PAGE_HEIGHT - MARGIN - FOOTER_HEIGHT + 4).stroke();
    document.fillColor(MUTED).font(REPORT_REGULAR).fontSize(7.5).text(`${companyName} | ${title}`, MARGIN, PAGE_HEIGHT - MARGIN - FOOTER_HEIGHT + 12, { width: CONTENT_WIDTH - 55 });
    const pageLabel = labels.page;
    document.text(`${pageLabel} ${page - range.start + 1} / ${range.count}`, PAGE_WIDTH - MARGIN - 55, PAGE_HEIGHT - MARGIN - FOOTER_HEIGHT + 12, { width: 55, align: "right" });
  }
  document.end();
  await new Promise<void>((resolve, reject) => { document.once("end", resolve); document.once("error", reject); });
  return new Uint8Array(Buffer.concat(chunks));
}
