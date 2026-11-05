const KWORB_URL = "https://kworb.net/spotify/artist/06HL4z0CvFAxyc27GXpf02_songs.html";
const APPLE_URL = "https://rss.applemarketingtools.com/api/v2/us/music/most-played/100/songs.json";
const BILLBOARD_URL = "https://www.billboard.com/charts/hot-100/";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const TAYLOR = "Taylor Swift";
const TTL = 6 * 3600;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};
let _cache = null, _cacheAt = 0;

function stripTags(s) {
  return s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#039;/g, "'").trim();
}
function parseNum(s) { return parseInt(String(s).replace(/[,\s*]/g, ""), 10) || 0; }

function parseKworb(html) {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => m[1]);
  let total = 0, daily = 0, tracks = 0;
  const songs = [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(m => stripTags(m[1]));
    if (!cells.length) continue;
    if (cells[0] === "Streams" && cells[1]) total = parseNum(cells[1]);
    else if (cells[0] === "Daily" && cells[1]) daily = parseNum(cells[1]);
    else if (cells[0] === "Tracks" && cells[1]) tracks = parseNum(cells[1]);
    else if (cells.length >= 3 && cells[0] !== "Song Title" && /^\d/.test(cells[1].replace(/,/g, ""))) {
      songs.push({ title: cells[0].replace(/^\*\s*/, ""), total_streams: parseNum(cells[1]), daily_streams: parseNum(cells[2]) });
    }
  }
  return {
    summary: { total_streams: total, daily_streams: daily, tracks },
    daily_top: [...songs].sort((a, b) => b.daily_streams - a.daily_streams).slice(0, 50).map((s, i) => ({ rank: i + 1, ...s })),
    cumulative_top: [...songs].sort((a, b) => b.total_streams - a.total_streams).slice(0, 50).map((s, i) => ({ rank: i + 1, ...s })),
  };
}

function parseApple(json) {
  const all = json.feed?.results || [];
  const taylor = [];
  all.forEach((s, i) => {
    if ((s.artistName || "").includes(TAYLOR)) {
      taylor.push({ rank: i + 1, title: s.name, artist: s.artistName, artwork: s.artworkUrl100 || null });
    }
  });
  return { chart_size: all.length, taylor_songs: taylor };
}

function parseBillboard(html) {
  const titles = [...html.matchAll(/<h3[^>]*id="title-of-a-story"[^>]*>([\s\S]*?)<\/h3>/g)].map(m => stripTags(m[1]));
  const skip = new Set(["Songwriter(s)", "Producer(s)", "Imprint/Label", "Gains in Weekly Performance", "Additional Awards"]);
  const songs = titles.filter(t => t && !skip.has(t));
  const taylorSongs = [];
  const re = new RegExp(TAYLOR, "g");
  let m;
  while ((m = re.exec(html)) !== null) {
    const around = html.slice(Math.max(0, m.index - 1200), m.index + 200);
    const h3s = [...around.matchAll(/<h3[^>]*id="title-of-a-story"[^>]*>([\s\S]*?)<\/h3>/g)].map(x => stripTags(x[1]));
    const lastSong = [...h3s].reverse().find(t => t && !skip.has(t));
    if (lastSong && !taylorSongs.find(s => s.title === lastSong)) {
      const rank = songs.indexOf(lastSong) + 1;
      if (rank > 0) taylorSongs.push({ rank, title: lastSong });
    }
  }
  return { chart_size: songs.length, taylor_songs: taylorSongs.sort((a, b) => a.rank - b.rank) };
}

async function fetchText(url) {
  const r = await fetch(url, { headers: { "user-agent": UA } });
  if (!r.ok) throw new Error(url + " -> " + r.status);
  return r.text();
}
async function fetchJson(url) {
  const r = await fetch(url, { headers: { "user-agent": UA } });
  if (!r.ok) throw new Error(url + " -> " + r.status);
  return r.json();
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }
  const now = Date.now();
  if (_cache && (now - _cacheAt) < TTL * 1000) {
    return {
      statusCode: 200,
      headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=0, s-maxage=" + TTL },
      body: JSON.stringify(_cache),
    };
  }
  const [kworbR, appleR, bbR] = await Promise.allSettled([
    fetchText(KWORB_URL), fetchJson(APPLE_URL), fetchText(BILLBOARD_URL),
  ]);
  const out = { fetched_at: new Date().toISOString(), artist: TAYLOR, sources: {} };
  out.sources.spotify_kworb = kworbR.status === "fulfilled"
    ? { ok: true, ...parseKworb(kworbR.value) }
    : { ok: false, error: String(kworbR.reason) };
  out.sources.apple_music = appleR.status === "fulfilled"
    ? { ok: true, chart: "US Top 100", ...parseApple(appleR.value) }
    : { ok: false, error: String(appleR.reason) };
  out.sources.billboard_hot100 = bbR.status === "fulfilled"
    ? { ok: true, chart: "Hot 100", ...parseBillboard(bbR.value) }
    : { ok: false, error: String(bbR.reason) };
  _cache = out; _cacheAt = now;
  return {
    statusCode: 200,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=0, s-maxage=" + TTL },
    body: JSON.stringify(out),
  };
};
