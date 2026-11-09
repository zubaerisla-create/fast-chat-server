/**
 * Server-side link previews (Open Graph / <title>) for the first URL in a message.
 * SSRF-safe: http(s) only, standard ports, every resolved address must be public,
 * no redirects to private hosts, 4 s timeout, 512 KB read cap, HTML only.
 */
const dns = require("dns").promises;
const net = require("net");

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/i;
const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 4000;

const firstUrl = (text = "") => {
  const m = String(text).match(URL_RE);
  return m ? m[0].replace(/[),.;!?]+$/, "") : null;
};

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

async function assertPublicUrl(raw) {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("bad protocol");
  if (url.port && !["80", "443"].includes(url.port)) throw new Error("bad port");
  if (url.username || url.password) throw new Error("credentials in URL");
  const addresses = net.isIP(url.hostname) ? [{ address: url.hostname }] : await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) throw new Error("private address");
  return url;
}

const decode = (s) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();

function meta(html, names) {
  for (const name of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, "i");
    const tag = html.match(re)?.[0];
    const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
    if (content) return decode(content).slice(0, 300);
  }
  return null;
}

async function fetchPreview(rawUrl, { fetchImpl = fetch } = {}) {
  let url = await assertPublicUrl(rawUrl);
  let res;
  for (let hop = 0; hop < 3; hop += 1) {
    res = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "user-agent": "FastChatLinkPreview/1.0", accept: "text/html" } });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = await assertPublicUrl(new URL(res.headers.get("location"), url).href);
      continue;
    }
    break;
  }
  if (!res.ok || !(res.headers.get("content-type") || "").includes("text/html")) return null;

  const reader = res.body.getReader();
  let html = "";
  let bytes = 0;
  while (bytes < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    html += Buffer.from(value).toString("utf8");
    if (html.includes("</head>")) break;
  }
  reader.cancel().catch(() => {});

  const title = meta(html, ["og:title", "twitter:title"]) || (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] && decode(html.match(/<title[^>]*>([^<]*)<\/title>/i)[1]).slice(0, 300));
  if (!title) return null;
  let image = meta(html, ["og:image", "twitter:image"]);
  try {
    image = image ? new URL(image, url).href : null;
    if (image && !image.startsWith("https://")) image = null; // only https images are embedded
  } catch {
    image = null;
  }
  return {
    url: url.href,
    title,
    description: meta(html, ["og:description", "description", "twitter:description"]),
    image,
    siteName: meta(html, ["og:site_name"]) || url.hostname,
  };
}

module.exports = { firstUrl, fetchPreview, isPrivateAddress, assertPublicUrl };
