export const AMAZON_MARKETPLACE_HOSTS = [
  "www.amazon.com",
  "www.amazon.ca",
  "www.amazon.com.mx",
  "www.amazon.com.br",
  "www.amazon.co.uk",
  "www.amazon.de",
  "www.amazon.fr",
  "www.amazon.it",
  "www.amazon.es",
  "www.amazon.nl",
  "www.amazon.se",
  "www.amazon.pl",
  "www.amazon.com.be",
  "www.amazon.co.jp",
  "www.amazon.in",
  "www.amazon.sg",
  "www.amazon.com.au",
  "www.amazon.ae",
  "www.amazon.sa",
  "www.amazon.eg",
  "www.amazon.com.tr",
] as const;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const BLOCKED_RESOURCE_TYPES = new Set([
  "websocket",
  "eventsource",
  "image",
  "media",
  "font",
]);
const ORDER_LIST_PATHS = [
  "/gp/css/order-history",
  "/gp/your-account/order-history",
  "/your-orders/orders",
] as const;

const ORDER_DETAIL_PATHS = [
  "/gp/your-account/order-details",
  "/your-orders/order-details",
  "/gp/css/summary/print.html",
] as const;

const AUTH_PATHS = [
  "/ap/signin",
  "/ap/mfa",
  "/ap/challenge",
  "/ap/cvf/",
  "/errors/validatecaptcha",
] as const;

const BLOCKED_TOKENS = new Set([
  "cart",
  "checkout",
  "buy",
  "buyagain",
  "purchase",
  "cancel",
  "cancellation",
  "return",
  "returns",
  "refund",
  "review",
  "reviews",
  "wishlist",
  "wish",
  "settings",
  "preferences",
  "address",
  "addresses",
  "payment",
  "payments",
  "signout",
  "logout",
]);

export type RequestGuardReason =
  | "allowed"
  | "invalid_marketplace"
  | "invalid_url"
  | "insecure_url"
  | "unapproved_host"
  | "unsafe_method"
  | "blocked_resource_type"
  | "blocked_path"
  | "unapproved_navigation"
  | "unapproved_subresource"
  | "unapproved_asset_request";

export interface AmazonRequestDescription {
  url: string;
  method: string;
  resourceType: string;
  /** Treat every navigation/document as independently untrusted, including redirects. */
  isNavigationRequest?: boolean;
}

export interface RequestGuardDecision {
  allow: boolean;
  reason: RequestGuardReason;
}

interface ParsedMarketplace {
  primaryHost: string;
  bareHost: string;
}

/**
 * A pure, deny-by-default policy for Playwright/Puppeteer request routing.
 * Evaluate every emitted request. In particular, never carry an allow decision
 * from a request to its redirect target.
 */
export function evaluateAmazonRequest(
  request: AmazonRequestDescription,
  marketplace: string,
): RequestGuardDecision {
  const parsedMarketplace = parseMarketplace(marketplace);
  if (!parsedMarketplace) {
    return deny("invalid_marketplace");
  }

  const method = request.method.trim().toUpperCase();
  if (!SAFE_METHODS.has(method)) {
    return deny("unsafe_method");
  }

  const resourceType = request.resourceType.trim().toLowerCase();
  if (BLOCKED_RESOURCE_TYPES.has(resourceType)) {
    return deny("blocked_resource_type");
  }

  const parsedUrl = parseHttpsUrl(request.url);
  if (parsedUrl.reason !== undefined) {
    return deny(parsedUrl.reason);
  }

  const url = parsedUrl.url;
  const hostKind = classifyHost(url.hostname, parsedMarketplace);
  if (hostKind === "unapproved") {
    return deny("unapproved_host");
  }

  const canonicalTarget = canonicalizeTarget(url);
  if (!canonicalTarget) {
    return deny("invalid_url");
  }
  if (containsBlockedOperation(canonicalTarget.path, canonicalTarget.queryParts)) {
    return deny("blocked_path");
  }

  const isNavigation =
    request.isNavigationRequest === true || resourceType === "document";
  if (isNavigation) {
    if (hostKind !== "marketplace") {
      return deny("unapproved_navigation");
    }
    return isApprovedTopLevelPath(url.pathname)
      ? allow()
      : deny("unapproved_navigation");
  }

  // Production reads disable site JavaScript and extract server-rendered DOM,
  // so no subresource is required. Deny even same-origin GET fetches here:
  // HTML can initiate prefetch/preload requests without JavaScript, and a
  // method-only policy cannot prove that every vendor GET endpoint is inert.
  return deny(hostKind === "asset" ? "unapproved_asset_request" : "unapproved_subresource");
}

/** Validate a top-level URL (including each redirect target) in isolation. */
export function evaluateAmazonNavigationTarget(
  url: string,
  marketplace: string,
): RequestGuardDecision {
  return evaluateAmazonRequest(
    {
      url,
      method: "GET",
      resourceType: "document",
      isNavigationRequest: true,
    },
    marketplace,
  );
}

export function isAmazonAuthenticationUrl(url: string, marketplace: string): boolean {
  const parsedMarketplace = parseMarketplace(marketplace);
  const parsedUrl = parseHttpsUrl(url);
  if (!parsedMarketplace || parsedUrl.reason !== undefined) {
    return false;
  }
  if (classifyHost(parsedUrl.url.hostname, parsedMarketplace) !== "marketplace") {
    return false;
  }

  const path = canonicalizePath(parsedUrl.url.pathname);
  return path !== undefined && AUTH_PATHS.some((allowed) => matchesPath(path, allowed));
}

export function normalizeAmazonMarketplace(marketplace: string): string | undefined {
  return parseMarketplace(marketplace)?.primaryHost;
}

function parseMarketplace(marketplace: string): ParsedMarketplace | undefined {
  const candidate = marketplace.trim().toLowerCase().replace(/\.$/u, "");
  const host = candidate.startsWith("www.") ? candidate : `www.${candidate}`;
  if (!(AMAZON_MARKETPLACE_HOSTS as readonly string[]).includes(host)) {
    return undefined;
  }
  return { primaryHost: host, bareHost: host.slice(4) };
}

function parseHttpsUrl(
  value: string,
): { url: URL; reason?: undefined } | { url?: never; reason: "invalid_url" | "insecure_url" } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { reason: "invalid_url" };
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== ""
  ) {
    return { reason: "insecure_url" };
  }
  return { url };
}

function classifyHost(
  hostname: string,
  marketplace: ParsedMarketplace,
): "marketplace" | "asset" | "unapproved" {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  if (host === marketplace.primaryHost || host === marketplace.bareHost) {
    return "marketplace";
  }
  if (host === "m.media-amazon.com" || host.endsWith(".ssl-images-amazon.com")) {
    return "asset";
  }
  return "unapproved";
}

function canonicalizeTarget(
  url: URL,
): { path: string; queryParts: string[] } | undefined {
  const path = canonicalizePath(url.pathname);
  if (path === undefined) {
    return undefined;
  }

  const queryParts: string[] = [];
  for (const [rawKey, rawValue] of url.searchParams) {
    const key = decodeRepeatedly(rawKey);
    const value = decodeRepeatedly(rawValue);
    if (key === undefined || value === undefined) {
      return undefined;
    }

    // Amazon's sign-in flow uses this standard OpenID redirect parameter. Its
    // name contains "return", but it is not a return-order operation. The
    // value is still inspected, so a target such as /checkout remains denied.
    if (key.toLowerCase() !== "openid.return_to") {
      queryParts.push(key.toLowerCase());
    }
    queryParts.push(value.toLowerCase());
  }

  return { path, queryParts };
}

function canonicalizePath(pathname: string): string | undefined {
  const decoded = decodeRepeatedly(pathname);
  if (decoded === undefined || /[\u0000-\u001f\u007f]/u.test(decoded)) {
    return undefined;
  }
  return decoded.replace(/\\/gu, "/").replace(/\/{2,}/gu, "/").toLowerCase();
}

function decodeRepeatedly(value: string): string | undefined {
  let current = value;
  try {
    for (let count = 0; count < 4; count += 1) {
      const decoded = decodeURIComponent(current);
      if (decoded === current) {
        return decoded;
      }
      current = decoded;
    }
    // If another decoding layer remains, reject instead of guessing.
    return /%[0-9a-f]{2}/iu.test(current) ? undefined : current;
  } catch {
    return undefined;
  }
}

function containsBlockedOperation(path: string, queryParts: string[]): boolean {
  if (/(?:^|[/_-])(?:sign[-_]?out|log[-_]?out)(?:[/.?_-]|$)/u.test(path)) {
    return true;
  }
  const tokens = [path, ...queryParts]
    .flatMap((part) => part.split(/[^a-z0-9]+/u))
    .filter(Boolean);
  return tokens.some((token) => BLOCKED_TOKENS.has(token));
}

function isApprovedTopLevelPath(pathname: string): boolean {
  const path = canonicalizePath(pathname);
  if (path === undefined) {
    return false;
  }
  return [...ORDER_LIST_PATHS, ...ORDER_DETAIL_PATHS, ...AUTH_PATHS].some((allowed) =>
    matchesPath(path, allowed),
  );
}

function matchesPath(path: string, allowed: string): boolean {
  if (allowed.endsWith("/")) {
    return path.startsWith(allowed);
  }
  return path === allowed || path.startsWith(`${allowed}/`);
}

function allow(): RequestGuardDecision {
  return { allow: true, reason: "allowed" };
}

function deny(reason: Exclude<RequestGuardReason, "allowed">): RequestGuardDecision {
  return { allow: false, reason };
}
