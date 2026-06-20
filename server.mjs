import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = join(ROOT, "public");
const PORT = Number(process.env.PORT || 4173);
const HOME_URL = "https://nrega.dord.gov.in/MGNREGA_new/Nrega_home.aspx";
const STATE = { code: "07", name: "DN HAVELI AND DD" };
const DISTRICT = "DADRA AND NAGAR HAVELI";
const BLOCK = "Dadra Nagar Haveli";
const SITE_VERSION = "1.4.0";

const entityMap = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };

function decodeHtml(value = "") {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);?/gi, (all, key) => {
    if (key[0] === "#") {
      const hex = key[1]?.toLowerCase() === "x";
      const number = Number.parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(number) ? String.fromCodePoint(number) : all;
    }
    return entityMap[key.toLowerCase()] ?? all;
  });
}

function stripTags(value = "") {
  return decodeHtml(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function parseAttributes(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/([\w:$-]+)\s*=\s*(["'])(.*?)\2/gs)) {
    attributes[match[1].toLowerCase()] = decodeHtml(match[3]);
  }
  return attributes;
}

function parseLinks(html) {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
    .map((match) => ({ ...parseAttributes(match[1]), text: stripTags(match[2]) }))
    .filter((link) => link.href);
}

function normalizeLabel(value) {
  return value.replace(/\s+/g, " ").trim().toUpperCase();
}

class PortalSession {
  constructor() {
    this.cookies = new Map();
  }

  rememberCookies(headers) {
    const values = headers.getSetCookie?.() ?? (headers.get("set-cookie") ? [headers.get("set-cookie")] : []);
    for (const value of values) {
      const pair = value.split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (separator > 0) this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }

  async request(url, { method = "GET", body, referer } = {}) {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-IN,en;q=0.9",
    };
    if (referer) headers.Referer = referer;
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; ");
    if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";

    const response = await fetch(url, { method, body, headers, redirect: "follow", signal: AbortSignal.timeout(45000) });
    this.rememberCookies(response.headers);
    const text = await response.text();
    if (!response.ok || /<h3>\s*Access Denied/i.test(text)) {
      throw new Error(`The NMMS portal refused the request (${response.status}). Please try again shortly.`);
    }
    return { text, url: response.url };
  }
}

function hiddenFields(html) {
  const fields = new URLSearchParams();
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    const attributes = parseAttributes(match[0]);
    if (attributes.type?.toLowerCase() === "hidden" && attributes.name) {
      fields.set(attributes.name, attributes.value ?? "");
    }
  }
  return fields;
}

function findLink(html, predicate, level) {
  const link = parseLinks(html).find(predicate);
  if (!link) throw new Error(`The NMMS portal did not return the expected ${level} link.`);
  return link.href;
}

function resolvePortalUrl(href, base) {
  const url = new URL(decodeHtml(href), base);
  url.protocol = "https:";
  return url.href;
}

function parsePanchayatTable(html) {
  const rows = [];
  let publishedAt = null;
  const stamp = stripTags(html).match(/\b\d{2}-[A-Za-z]{3}-\d{4}\s+\d{1,2}:\d{2}:\d{2}\s+[AP]M\b/);
  if (stamp) publishedAt = stamp[0];

  for (const rowMatch of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => stripTags(cell[1]));
    if (cells.length < 5) continue;
    const serial = Number.parseInt(cells[0], 10);
    const works = Number.parseInt(cells[2].replaceAll(",", ""), 10);
    const musterRolls = Number.parseInt(cells[3].replaceAll(",", ""), 10);
    const persondays = Number.parseInt(cells[4].replaceAll(",", ""), 10);
    if (Number.isFinite(serial) && cells[1] && [works, musterRolls, persondays].every(Number.isFinite)) {
      const rowLink = parseLinks(rowMatch[1]).find((link) => /NMMS_DailyAttendance_Summary\.aspx/i.test(link.href));
      rows.push({ serial, panchayat: cells[1], works, musterRolls, persondays, summaryHref: rowLink?.href });
    }
  }

  if (!rows.length) throw new Error("No panchayat rows were returned for that date.");
  const totals = rows.reduce(
    (sum, row) => ({ works: sum.works + row.works, musterRolls: sum.musterRolls + row.musterRolls, persondays: sum.persondays + row.persondays }),
    { works: 0, musterRolls: 0, persondays: 0 },
  );
  return { rows, totals, publishedAt };
}

function parseMusterTable(html) {
  const rows = [];
  for (const rowMatch of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => stripTags(cell[1]));
    if (cells.length < 7) continue;
    const serial = Number.parseInt(cells[0], 10);
    const persondays = Number.parseInt(cells[6].replaceAll(",", ""), 10);
    if (!Number.isFinite(serial) || !cells[4] || !cells[5] || !Number.isFinite(persondays)) continue;
    const detailLink = parseLinks(rowMatch[1]).find((link) => /Summary_Details\.aspx/i.test(link.href));
    rows.push({
      serial,
      district: cells[1],
      block: cells[2],
      panchayat: cells[3],
      workCode: cells[4],
      musterNumber: cells[5],
      persondays,
      detailHref: detailLink?.href,
    });
  }
  if (!rows.length) throw new Error("No muster-roll rows were returned for that panchayat.");
  return rows;
}

function parseWorkName(html) {
  const label = html.match(/<span\b[^>]*id=["'][^"']*lbl_dtl["'][^>]*>([\s\S]*?)<\/span>/i);
  const text = stripTags(label?.[1] ?? "");
  const name = text.match(/Work Name\s*:\s*(.+)$/i)?.[1]?.trim();
  return name || "Name unavailable on portal";
}

function formatPortalDate(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || "");
  if (!match) throw new Error("Please choose a valid attendance date.");
  return `${match[3]}/${match[2]}/${match[1]}`;
}

async function navigateToPanchayats(isoDate) {
  const attendanceDate = formatPortalDate(isoDate);
  const session = new PortalSession();
  const home = await session.request(HOME_URL);
  const reportMatch = home.text.match(/https?:\/\/mnregaweb4\.dord\.gov\.in\/netnrega\/NMMS_DailyAttendance\.aspx[^"']+/i);
  if (!reportMatch) throw new Error("The daily attendance link is temporarily unavailable on the NREGA portal.");
  const entryUrl = decodeHtml(reportMatch[0]).replace(/^http:/i, "https:");

  const formPage = await session.request(entryUrl, { referer: HOME_URL });
  const body = hiddenFields(formPage.text);
  body.set("ctl00$ContentPlaceHolder1$ddlstate", STATE.code);
  body.set("ctl00$ContentPlaceHolder1$ddl_attendance", attendanceDate);
  body.set("ctl00$ContentPlaceHolder1$btn_showreport", "Show Attendance");

  const stateResults = await session.request(formPage.url, { method: "POST", body, referer: formPage.url });
  const stateHref = findLink(
    stateResults.text,
    (link) => /[?&]page=S(?:&|$)/i.test(link.href) && normalizeLabel(link.text) === STATE.name,
    "state",
  );
  const stateUrl = resolvePortalUrl(stateHref, stateResults.url);
  const districtResults = await session.request(stateUrl, { referer: stateResults.url });
  const districtHref = findLink(districtResults.text, (link) => normalizeLabel(link.text) === DISTRICT, "district");
  const districtUrl = resolvePortalUrl(districtHref, districtResults.url);
  const blockResults = await session.request(districtUrl, { referer: districtResults.url });
  const blockHref = findLink(blockResults.text, (link) => normalizeLabel(link.text) === normalizeLabel(BLOCK), "block");
  const blockUrl = resolvePortalUrl(blockHref, blockResults.url);
  const panchayatResults = await session.request(blockUrl, { referer: blockResults.url });
  return { session, attendanceDate, panchayatResults };
}

async function fetchAttendance(isoDate) {
  const { attendanceDate, panchayatResults } = await navigateToPanchayats(isoDate);
  const parsed = parsePanchayatTable(panchayatResults.text);

  return {
    state: STATE.name,
    district: DISTRICT,
    block: BLOCK,
    attendanceDate,
    source: HOME_URL,
    fetchedAt: new Date().toISOString(),
    ...parsed,
    rows: parsed.rows.map(({ summaryHref, ...row }) => row),
  };
}

const musterCache = new Map();

async function fetchMustersFromNavigation({ attendanceDate, session, panchayatResults }, requestedPanchayat) {
  const panchayats = parsePanchayatTable(panchayatResults.text).rows;
  const selected = panchayats.find((row) => normalizeLabel(row.panchayat) === normalizeLabel(requestedPanchayat || ""));
  if (!selected) throw new Error("Please choose a panchayat from the attendance table.");
  if (!selected.summaryHref || selected.musterRolls === 0) throw new Error("No muster rolls are available for this panchayat.");

  const musterUrl = resolvePortalUrl(selected.summaryHref, panchayatResults.url);
  const musterPage = await session.request(musterUrl, { referer: panchayatResults.url });
  const musterRows = parseMusterTable(musterPage.text);
  const firstDetailByWork = new Map();
  for (const row of musterRows) {
    if (row.detailHref && !firstDetailByWork.has(row.workCode)) firstDetailByWork.set(row.workCode, row.detailHref);
  }

  const workNames = new Map();
  for (const [workCode, detailHref] of firstDetailByWork) {
    try {
      const detailUrl = resolvePortalUrl(detailHref, musterPage.url);
      const detailPage = await session.request(detailUrl, { referer: musterPage.url });
      workNames.set(workCode, parseWorkName(detailPage.text));
    } catch {
      workNames.set(workCode, "Name unavailable on portal");
    }
  }

  const rows = musterRows.map(({ detailHref, ...row }) => ({
    ...row,
    workName: workNames.get(row.workCode) || "Name unavailable on portal",
  }));
  const workSummaryMap = new Map();
  for (const row of rows) {
    const summary = workSummaryMap.get(row.workCode) || {
      workCode: row.workCode,
      workName: row.workName,
      musterRolls: 0,
      labourAttendance: 0,
    };
    summary.musterRolls += 1;
    summary.labourAttendance += row.persondays;
    workSummaryMap.set(row.workCode, summary);
  }
  const workSummaries = [...workSummaryMap.values()];
  const totalLabourAttendance = rows.reduce((sum, row) => sum + row.persondays, 0);
  const value = {
    state: STATE.name,
    district: DISTRICT,
    block: BLOCK,
    panchayat: selected.panchayat,
    attendanceDate,
    uniqueWorks: workNames.size,
    totalPersondays: totalLabourAttendance,
    totalLabourAttendance,
    workSummaries,
    rows,
  };
  return value;
}

async function fetchPanchayatMusters(isoDate, requestedPanchayat) {
  const cacheKey = `${isoDate}|${normalizeLabel(requestedPanchayat || "")}`;
  const cached = musterCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < 5 * 60 * 1000) return cached.value;
  const value = await fetchMustersFromNavigation(await navigateToPanchayats(isoDate), requestedPanchayat);
  musterCache.set(cacheKey, { savedAt: Date.now(), value });
  return value;
}

function recentIsoDates(endIso, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(endIso || "");
  if (!match) throw new Error("Please choose a valid comparison end date.");
  const count = Math.max(2, Math.min(7, Number.parseInt(days, 10) || 7));
  const end = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Array.from({ length: count }, (_, offset) => {
    const date = new Date(end);
    date.setUTCDate(end.getUTCDate() - (count - 1 - offset));
    return date.toISOString().slice(0, 10);
  });
}

const historyCache = new Map();

async function fetchHistory(endIso, days, requestedPanchayat) {
  const isoDates = recentIsoDates(endIso, days);
  const cacheKey = `${isoDates.join(",")}|${normalizeLabel(requestedPanchayat || "")}`;
  const cached = historyCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < 10 * 60 * 1000) return cached.value;

  const daySnapshots = [];
  for (const isoDate of isoDates) {
    const navigation = await navigateToPanchayats(isoDate);
    const panchayatReport = parsePanchayatTable(navigation.panchayatResults.text);
    const selected = panchayatReport.rows.find((row) => normalizeLabel(row.panchayat) === normalizeLabel(requestedPanchayat || ""));
    let musterDetails = { rows: [], workSummaries: [], totalLabourAttendance: 0 };
    if (selected?.musterRolls > 0 && selected.summaryHref) {
      musterDetails = await fetchMustersFromNavigation(navigation, selected.panchayat);
      musterCache.set(`${isoDate}|${normalizeLabel(selected.panchayat)}`, { savedAt: Date.now(), value: musterDetails });
    }
    daySnapshots.push({
      isoDate,
      attendanceDate: navigation.attendanceDate,
      panchayats: panchayatReport.rows.map(({ summaryHref, ...row }) => row),
      selected: selected ? { ...selected, summaryHref: undefined } : { panchayat: requestedPanchayat, works: 0, musterRolls: 0, persondays: 0 },
      workSummaries: musterDetails.workSummaries,
    });
  }

  const panchayatNames = [...new Set(daySnapshots.flatMap((day) => day.panchayats.map((row) => row.panchayat)))];
  const panchayatWeekly = panchayatNames.map((panchayat) => {
    const daily = daySnapshots.map((day) => {
      const row = day.panchayats.find((item) => item.panchayat === panchayat);
      return { isoDate: day.isoDate, attendanceDate: day.attendanceDate, persondays: row?.persondays || 0, musterRolls: row?.musterRolls || 0, works: row?.works || 0 };
    });
    return {
      panchayat,
      daily,
      weeklyPersondays: daily.reduce((sum, day) => sum + day.persondays, 0),
      latest: daily.at(-1)?.persondays || 0,
      previous: daily.at(-2)?.persondays || 0,
      change: (daily.at(-1)?.persondays || 0) - (daily.at(-2)?.persondays || 0),
    };
  });

  const workCodes = [...new Set(daySnapshots.flatMap((day) => day.workSummaries.map((work) => work.workCode)))];
  const workWeekly = workCodes.map((workCode) => {
    const found = daySnapshots.flatMap((day) => day.workSummaries).find((work) => work.workCode === workCode);
    const daily = daySnapshots.map((day) => {
      const work = day.workSummaries.find((item) => item.workCode === workCode);
      return { isoDate: day.isoDate, attendanceDate: day.attendanceDate, labourAttendance: work?.labourAttendance || 0, musterRolls: work?.musterRolls || 0 };
    });
    return {
      workCode,
      workName: found?.workName || "Name unavailable on portal",
      daily,
      weeklyLabourAttendance: daily.reduce((sum, day) => sum + day.labourAttendance, 0),
      latest: daily.at(-1)?.labourAttendance || 0,
      previous: daily.at(-2)?.labourAttendance || 0,
      change: (daily.at(-1)?.labourAttendance || 0) - (daily.at(-2)?.labourAttendance || 0),
    };
  });

  const selectedDaily = daySnapshots.map((day) => ({
    isoDate: day.isoDate,
    attendanceDate: day.attendanceDate,
    persondays: day.selected.persondays,
    musterRolls: day.selected.musterRolls,
    works: day.selected.works,
  }));
  const value = {
    version: SITE_VERSION,
    generatedAt: new Date().toISOString(),
    days: daySnapshots.map(({ isoDate, attendanceDate }) => ({ isoDate, attendanceDate })),
    selectedPanchayat: requestedPanchayat,
    selectedDaily,
    selectedWeeklyPersondays: selectedDaily.reduce((sum, day) => sum + day.persondays, 0),
    panchayatWeekly,
    workWeekly,
  };
  historyCache.set(cacheKey, { savedAt: Date.now(), value });
  return value;
}

const mimeTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };

function sendJson(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

async function serveStatic(pathname, response) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC, safePath);
  if (!filePath.startsWith(PUBLIC)) return false;
  try {
    const contents = await readFile(filePath);
    response.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    response.end(contents);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (request.method === "GET" && url.pathname === "/api/attendance") {
    try {
      sendJson(response, 200, await fetchAttendance(url.searchParams.get("date")));
    } catch (error) {
      console.error(error);
      sendJson(response, 502, { error: error.message || "Unable to read the NMMS portal." });
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/musters") {
    try {
      sendJson(response, 200, await fetchPanchayatMusters(url.searchParams.get("date"), url.searchParams.get("panchayat")));
    } catch (error) {
      console.error(error);
      sendJson(response, 502, { error: error.message || "Unable to read the muster-roll details." });
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/history") {
    try {
      sendJson(response, 200, await fetchHistory(url.searchParams.get("end"), url.searchParams.get("days"), url.searchParams.get("panchayat")));
    } catch (error) {
      console.error(error);
      sendJson(response, 502, { error: error.message || "Unable to build the attendance comparison." });
    }
    return;
  }
  if (request.method === "GET" && (await serveStatic(url.pathname, response))) return;
  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`NMMS Attendance Shortcut is running at http://127.0.0.1:${PORT}`);
});
