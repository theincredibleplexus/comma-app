// ─── CSV PARSER ──────────────────────────────────────────────────────────────
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current); current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function parseCSV(text) {
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]).map(h => h.trim().replace(/^\uFEFF/, ''));
  return lines.slice(1).map(line => {
    const values = parseCSVLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = (values[i] || '').trim(); });
    return row;
  }).filter(row => Object.values(row).some(v => v));
}

// ─── FETCH ───────────────────────────────────────────────────────────────────
export async function fetchCSV(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseCSV(await res.text());
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthKey(date) { return MONTH_NAMES[date.getMonth()]; }
function monthKeyYY(date) { return `${MONTH_NAMES[date.getMonth()]}'${String(date.getFullYear()).slice(2)}`; }

function parseDate(str) {
  if (!str) return null;
  // ISO: YYYY-MM-DD
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
  // Australian: DD/MM/YYYY
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]));
  return null;
}

function findCol(row, variants) {
  const rowKeys = Object.keys(row);
  const rowKeysLower = rowKeys.map(k => k.toLowerCase().trim());
  for (const v of variants) {
    const idx = rowKeysLower.indexOf(v.toLowerCase());
    if (idx !== -1) return rowKeys[idx];
  }
  return null;
}

function parseAmount(str) {
  if (!str) return 0;
  return parseFloat(str.replace(/[$,\s]/g, '')) || 0;
}

function getSortedMonths(dates) {
  if (dates.length === 0) return [];
  const minDate = new Date(Math.min(...dates.map(d => d.getTime())));
  const maxDate = new Date(Math.max(...dates.map(d => d.getTime())));
  const months = [];
  const cur = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
  while (cur <= maxDate) {
    months.push({ key: monthKey(cur), year: cur.getFullYear(), month: cur.getMonth() });
    cur.setMonth(cur.getMonth() + 1);
  }
  return months;
}

// ─── UP BANK ─────────────────────────────────────────────────────────────────

// ─── UNIVERSAL CATEGORISATION ENGINE ─────────────────────────────────────────
// Maps transaction description patterns → spending categories.
// Used by all bank CSV parsers (Up Bank, CBA, NAB, Westpac, ANZ, etc.).
// UPBANK_CATEGORY_MAP takes priority when present; this map is the fallback
// for banks that don't include a category column in their CSV exports.
// ORDER MATTERS: the loop breaks on the first match, so more specific patterns
// must appear before broader ones (e.g. grocery_delivery before grocery,
// delivery before transport, health before insurance).
const MERCHANT_MAP = {
  // ── Subscriptions & digital services ──────────────────────────────────────
  // Must come before amazon/paypal so "Amazon Prime" → sub, not amazon
  sub: [
    /netflix/i, /spotify/i, /\bstan\b/i, /disney\+/i, /disney plus/i,
    /youtube premium/i, /\bkayo\b/i, /\bbinge\b/i, /foxtel/i,
    /paramount\+/i, /paramount plus/i, /amazon prime/i,
    /\badobe\b/i, /\bcanva\b/i, /chatgpt/i, /openai/i,
    /\bclaude\b/i, /anthropic/i, /microsoft 365/i, /\bdropbox\b/i,
    /\bicloud\b/i, /grammarly/i, /\baudible\b/i, /\bkindle\b/i,
    /\bpatreon\b/i, /\bgithub\b/i, /\bnotion\b/i, /crunchyroll/i, /\bdazn\b/i,
    /apple\.com/i, /app store/i, /apple music/i, /apple one/i, /apple tv/i,
    /google one/i, /google workspace/i, /google storage/i,
  ],

  // ── Legacy merchant trackers (kept for existing chart aggregations) ────────
  amazon: [/amazon/i, /amzn/i],
  paypal: [/paypal/i],

  // ── Grocery delivery (before grocery — "Woolworths Online" → grocery_delivery) ──
  grocery_delivery: [
    /woolworths online/i, /coles online/i, /amazon fresh/i,
    /\bmilkrun\b/i, /\bvoly\b/i,
  ],

  // ── Groceries ─────────────────────────────────────────────────────────────
  grocery: [
    /\bwoolworths\b/i, /\bwoolies\b/i, /\bcoles\b/i, /\baldi\b/i,
    /\biga\b/i, /harris farm/i, /\bcostco\b/i, /foodworks/i,
    /spudshed/i, /\bdrakes\b/i, /ritchies/i, /farmer jacks/i,
    /fresh provisions/i,
  ],

  // ── Food & drink ──────────────────────────────────────────────────────────
  restaurant: [
    /restaurant/i, /\bcafe\b/i, /dining/i, /bistro/i, /\bpizza\b/i,
    /\bsushi\b/i, /\bthai\b/i, /\bindian\b/i, /\bchinese\b/i,
    /\bgrill\b/i, /\bkitchen\b/i, /bar & grill/i, /bar and grill/i,
    /\bburger\b/i,
  ],
  takeaway: [
    /mcdonald/i, /maccas/i, /\bkfc\b/i, /hungry jack/i, /\bsubway\b/i,
    /guzman/i, /nando/i, /dominos/i, /domino's/i, /\bgrill'd\b/i,
    /oporto/i, /red rooster/i, /zambrero/i, /roll'd/i,
    /betty's burger/i, /schnitz/i,
  ],
  coffee: [
    /coffee/i, /barista/i, /starbucks/i, /gloria jean/i, /mecca.*espresso/i,
    /patricia.*coffee/i, /market lane/i, /\baxil\b/i, /st ali/i,
    /industry beans/i, /\bcampos\b/i, /single o/i,
  ],

  // ── Delivery apps (before transport — "Uber Eats" → delivery, not transport) ──
  delivery: [/doordash/i, /uber eats/i, /menulog/i, /deliveroo/i],

  // ── Transport ─────────────────────────────────────────────────────────────
  transport: [
    /\bmyki\b/i, /\bopal\b/i, /\bgo card\b/i, /translink/i,
    /\buber\b/i, /\bdidi\b/i, /\bola\b/i, /\btaxi\b/i,
    /\b13cabs\b/i, /ingogo/i, /\blime\b/i, /\bbeam\b/i, /neuron/i,
  ],

  // ── Vehicle ───────────────────────────────────────────────────────────────
  fuel: [
    /\bbp\b/i, /shell/i, /7-eleven/i, /puma/i, /coles express/i,
    /ampol/i, /united petrol/i, /costco fuel/i, /liberty petrol/i,
    /metro petroleum/i, /speedway/i, /\bvibe\b/i,
  ],
  toll: [
    /citylink/i, /eastlink/i, /\blinkt\b/i, /mylinkt/i, /e-toll/i,
    /\be-tag\b/i, /\broam\b/i, /\bm5\b/i, /\bm7\b/i, /westconnex/i,
    /go via/i,
  ],

  // ── Home bills ────────────────────────────────────────────────────────────
  utilities: [
    /\bagl\b/i, /origin energy/i, /energy australia/i, /alinta/i,
    /red energy/i, /lumo energy/i, /simply energy/i, /powershop/i,
    /momentum energy/i, /globibird/i, /yarra valley water/i,
    /sydney water/i, /\bsa water\b/i, /city west water/i,
    /south east water/i, /council rates/i,
  ],
  telco: [
    /telstra/i, /\boptus\b/i, /vodafone/i, /aussie broadband/i,
    /\btpg\b/i, /\biinet\b/i, /tangerine telecom/i, /\bbelong\b/i,
    /spintel/i, /\bdodo\b/i, /exetel/i, /superloop/i,
    /buddy telco/i, /mate communicate/i, /amaysim/i,
  ],

  // ── Health (before insurance — "Bupa Dental" → health, not insurance) ─────
  health: [
    /chemist warehouse/i, /priceline pharmacy/i, /terrywhite/i,
    /terry white/i, /\bblooms\b/i, /ramsay health/i, /healthscope/i,
    /bupa dental/i, /hcf dental/i, /pacific smiles/i,
  ],
  insurance: [
    /\baami\b/i, /allianz/i, /\bbupa\b/i, /medibank/i, /\bhcf\b/i,
    /\bnib\b/i, /\bahm\b/i, /\bracv\b/i, /\bnrma\b/i, /suncorp/i,
    /\bcgu\b/i, /\bqbe\b/i, /\bgio\b/i, /budget direct/i,
    /\byoui\b/i, /real insurance/i, /\btid\b/i, /woolworths insurance/i,
  ],

  // ── Lifestyle ─────────────────────────────────────────────────────────────
  fitness: [
    /fitness first/i, /anytime fitness/i, /\bf45\b/i, /\bjetts\b/i,
    /goodlife/i, /virgin active/i, /barry's/i, /plus fitness/i,
    /snap fitness/i, /\bgym\b/i, /crossfit/i, /\byoga\b/i,
    /pilates/i, /\brouvy\b/i, /\bzwift\b/i, /\bstrava\b/i,
  ],
  education: [
    /university/i, /\btafe\b/i, /coursera/i, /udemy/i,
    /skillshare/i, /linkedin learning/i, /textbook/i,
  ],
  clothing: [
    /uniqlo/i, /\bzara\b/i, /\bh&m\b/i, /cotton on/i, /country road/i,
    /\bmyer\b/i, /david jones/i, /the iconic/i, /\basos\b/i,
  ],
  home: [
    /bunnings/i, /\bikea\b/i, /\bkmart\b/i, /\btarget\b/i,
    /officeworks/i, /harvey norman/i, /jb hi-fi/i, /jb hifi/i,
    /the good guys/i, /fantastic furniture/i, /\bfreedom\b/i,
    /temple & webster/i, /\badairs\b/i,
  ],
  pets: [
    /petstock/i, /petbarn/i, /city farmers/i, /greencross/i, /\bvet\b/i,
  ],
  travel: [
    /airbnb/i, /booking\.com/i, /expedia/i, /\bhotel/i,
    /\bqantas\b/i, /virgin australia/i, /jetstar/i, /rex airlines/i,
    /skyscanner/i, /\bflight\b/i,
  ],
  gambling: [
    /\btab\b/i, /sportsbet/i, /ladbrokes/i, /bet365/i,
    /pointsbet/i, /\bneds\b/i, /unibet/i, /\bcrown\b/i,
    /star casino/i, /\bpokies\b/i,
  ],

  // ── Government ────────────────────────────────────────────────────────────
  government: [
    /\bato\b/i, /service nsw/i, /vicroads/i, /\bmygov\b/i,
    /\bmedicare\b/i, /centrelink/i, /\bcouncil\b/i,
  ],

  // ── Housing ───────────────────────────────────────────────────────────────
  mortgage: [/mortgage/i, /home loan/i, /\boffset\b/i, /\bredraw\b/i],
  rent:     [/ray white/i, /real estate/i, /\bproperty\b/i, /tenancy/i, /\blease\b/i, /\brea\b/i, /\bdomain\b/i],

  // ── Financial flows ───────────────────────────────────────────────────────
  // transfer: flag so users can choose to exclude from spending totals
  transfer: [/\btransfer\b/i, /\bbpay\b/i, /pay anyone/i, /\binternal\b/i, /\bsweep\b/i],
  income:   [/salary/i, /\bwages\b/i, /\bpay\b/i, /\bxero\b/i, /employment hero/i, /keypay/i, /dividend/i, /\binterest\b/i, /\brefund\b/i, /cashback/i, /\brebate\b/i],
};

const UPBANK_CATEGORY_MAP = {
  'Restaurants & Cafes': 'restaurant',
  'Takeaway':            'takeaway',
  'Groceries':           'grocery',
  'Medical & Pharmacy':  'health',
  'Fitness & Wellbeing': 'health',
  'Doctor':              'health',
  'Subscriptions & Lifestyle': 'sub',
  'Transport':           'transport',
  'Fuel':                'fuel',
  'Income':              'income',
  'Savings':             'savings_transfer',
  'Investments':         'savings_transfer',
};

const HEALTH_SUBCATS = {
  Vision:          [/specsavers/i, /opsm/i, /vision/i, /optical/i],
  Pharmacy:        [/chemist warehouse/i, /pharmacy/i, /priceline/i],
  'Mental Health': [/psychology/i, /psychiatr/i, /psychologist/i, /counsell/i],
  GP:              [/medical centre/i, /\bgp\b/i, /doctor/i, /clinic/i],
  Physio:          [/physio/i, /osteo/i, /chiro/i],
  Surgery:         [/hospital/i, /surgeon/i, /surgical/i],
};

const HEALTH_COLORS = {
  Vision: '#06b6d4', Pharmacy: '#f97316', 'Mental Health': '#ec4899',
  GP: '#8b5cf6', Physio: '#22c55e', Surgery: '#ef4444',
};

const DOW_ORDERED = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DOW_NAMES   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function processUpBank(rows) {
  if (!rows || rows.length === 0) return null;

  const sample = rows[0];
  const dateCol = findCol(sample, ['date', 'transaction date']);
  const descCol = findCol(sample, ['description', 'merchant', 'name']);
  const amtCol  = findCol(sample, ['value', 'amount', 'debit/credit']);
  const catCol  = findCol(sample, ['category', 'up category']);

  if (!dateCol || !descCol || !amtCol) return null;

  // Parse and classify each row
  const txs = rows.map(r => {
    const date = parseDate(r[dateCol] || '');
    if (!date) return null;
    const amount = parseAmount(r[amtCol]);
    const desc = r[descCol] || '';
    const upCat = catCol ? (r[catCol] || '') : '';

    const isIncome = amount > 0;
    const absAmt = Math.abs(amount);

    let merchant = null;
    for (const [cat, patterns] of Object.entries(MERCHANT_MAP)) {
      if (patterns.some(p => p.test(desc))) { merchant = cat; break; }
    }

    const mappedCat = UPBANK_CATEGORY_MAP[upCat];
    const cat = mappedCat || merchant || (isIncome ? 'income' : 'other');

    return { date, desc, absAmt, isIncome, merchant, cat, upCat };
  }).filter(Boolean);

  if (txs.length === 0) return null;

  const months = getSortedMonths(txs.map(t => t.date));
  const monthKeys = months.map(m => m.key);

  const md = {};
  monthKeys.forEach(k => {
    md[k] = { income: 0, spending: 0, amazon: 0, paypal: 0, toll: 0, coffee: 0, delivery: 0, restaurant: 0, takeaway: 0, grocery: 0, healthRec: 0, healthOne: 0, healthMC: 0 };
  });

  const dowData = {};
  DOW_NAMES.forEach(d => { dowData[d] = { sum: 0, cnt: 0 }; });

  const hcatAcc = {};

  txs.forEach(tx => {
    const mk = monthKey(tx.date);
    if (!md[mk]) return;

    if (tx.isIncome) {
      md[mk].income += tx.absAmt;
    } else {
      md[mk].spending += tx.absAmt;
      const d = DOW_NAMES[tx.date.getDay()];
      dowData[d].sum += tx.absAmt;
      dowData[d].cnt += 1;
    }

    if (tx.merchant === 'amazon')   md[mk].amazon   += tx.absAmt;
    if (tx.merchant === 'paypal')   md[mk].paypal   += tx.absAmt;
    if (tx.merchant === 'toll')     md[mk].toll     += tx.absAmt;
    if (tx.merchant === 'coffee')   md[mk].coffee   += tx.absAmt;
    if (tx.merchant === 'delivery') md[mk].delivery += tx.absAmt;

    if (tx.cat === 'restaurant') md[mk].restaurant += tx.absAmt;
    if (tx.cat === 'takeaway')   md[mk].takeaway   += tx.absAmt;
    if (tx.cat === 'grocery')    md[mk].grocery    += tx.absAmt;

    const isHealth = tx.cat === 'health' || /Medical|Fitness|Doctor/i.test(tx.upCat);
    if (isHealth) {
      let sub = 'Other';
      for (const [name, pats] of Object.entries(HEALTH_SUBCATS)) {
        if (pats.some(p => p.test(tx.desc))) { sub = name; break; }
      }
      hcatAcc[sub] = (hcatAcc[sub] || 0) + tx.absAmt;

      if (/medicare/i.test(tx.desc)) md[mk].healthMC  += tx.absAmt;
      else if (tx.absAmt > 500)      md[mk].healthOne += tx.absAmt;
      else                           md[mk].healthRec += tx.absAmt;
    }
  });

  const round = v => Math.round(v);

  const pnl  = monthKeys.map(m => ({ m, i: round(md[m].income), s: round(md[m].spending), n: round(md[m].income - md[m].spending) }));
  const amz  = monthKeys.map(m => ({ m, v: round(md[m].amazon) }));
  const food = monthKeys.map(m => ({ m, r: round(md[m].restaurant), t: round(md[m].takeaway), g: round(md[m].grocery) }));
  const hm   = monthKeys.map(m => ({ m, rec: round(md[m].healthRec), one: round(md[m].healthOne), mc: round(md[m].healthMC) }));
  const cd   = monthKeys.map(m => ({ m, a: round(md[m].amazon), p: round(md[m].paypal) }));
  const bva  = monthKeys.map(m => ({ m, amazon: round(md[m].amazon), tolls: round(md[m].toll), coffee: round(md[m].coffee), delivery: round(md[m].delivery) }));

  const hcats = Object.entries(hcatAcc)
    .sort((a, b) => b[1] - a[1])
    .map(([n, t]) => ({ n, t: round(t), c: HEALTH_COLORS[n] || '#94a3b8' }));

  const dow = DOW_ORDERED.map(d => ({ d, avg: dowData[d].cnt > 0 ? round(dowData[d].sum / dowData[d].cnt) : 0 }));

  const allDates = txs.map(t => t.date);
  const minDate = new Date(Math.min(...allDates.map(d => d.getTime())));
  const maxDate = new Date(Math.max(...allDates.map(d => d.getTime())));
  const dateRange = {
    start: `${MONTH_NAMES[minDate.getMonth()]} ${minDate.getFullYear()}`,
    end:   `${MONTH_NAMES[maxDate.getMonth()]} ${maxDate.getFullYear()}`,
    minDate, maxDate,
  };

  // Daily spending totals for heatmap
  const dailyTotals = {};
  for (const tx of txs) {
    if (!tx.isIncome) {
      const d = tx.date;
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      dailyTotals[key] = (dailyTotals[key] || 0) + tx.absAmt;
    }
  }

  // Individual transactions for search (spending only, newest first)
  const transactions = txs
    .filter(tx => !tx.isIncome)
    .map(tx => {
      const d = tx.date;
      return {
        date: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`,
        desc: tx.desc,
        amount: tx.absAmt,
        cat: tx.cat,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));

  return { pnl, amz, food, hm, hcats, dow, cd, bva, dateRange, dailyTotals, transactions, rowCount: txs.length };
}

// ─── PAYPAL ──────────────────────────────────────────────────────────────────
const PAYPAL_CATS = {
  'Vehicle':        [/autobarn/i, /repco/i, /supercheap/i],
  'Tech':           [/microsoft/i, /google/i, /steam/i, /adobe/i, /logitech/i, /corsair/i],
  'Motorcycle':     [/peter steven/i, /mcas/i, /bikebiz/i],
  'Fitness':        [/zwift/i, /strava/i, /garmin/i, /oura/i, /fitbit/i],
  'eBay':           [/ebay/i],
  'Events+Travel':  [/eventbrite/i, /airbnb/i, /booking\./i, /ticketek/i, /ticketmaster/i, /viator/i],
};

const PAYPAL_CAT_COLORS = {
  'Vehicle': '#ef4444', 'Tech': '#6366f1', 'Motorcycle': '#f97316',
  'Fitness': '#22c55e', 'eBay': '#eab308', 'Events+Travel': '#ec4899', 'Other': '#94a3b8',
};

export function processPayPal(rows) {
  if (!rows || rows.length === 0) return null;

  const sample = rows[0];
  const dateCol   = findCol(sample, ['date']);
  const nameCol   = findCol(sample, ['name', 'description']);
  const grossCol  = findCol(sample, ['gross', 'amount']);
  const statusCol = findCol(sample, ['status']);

  if (!dateCol || !grossCol) return null;

  // Completed outgoing payments only
  const payments = rows.filter(r => {
    if (statusCol && !/completed/i.test(r[statusCol] || '')) return false;
    return parseAmount(r[grossCol]) < 0;
  });

  if (payments.length === 0) return null;

  const withDates = payments.map(r => {
    const date = parseDate(r[dateCol] || '');
    if (!date) return null;
    return { date, absAmt: Math.abs(parseAmount(r[grossCol])), name: r[nameCol] || '' };
  }).filter(Boolean);

  if (withDates.length === 0) return null;

  const months = getSortedMonths(withDates.map(t => t.date));
  const monthKeys = months.map(m => m.key);

  const monthTotals = {};
  monthKeys.forEach(k => { monthTotals[k] = 0; });
  withDates.forEach(({ date, absAmt }) => {
    const mk = monthKey(date);
    if (monthTotals[mk] !== undefined) monthTotals[mk] += absAmt;
  });

  const ppM = monthKeys.map(m => ({ m, p: Math.round(monthTotals[m] || 0) }));

  const catTotals = {};
  withDates.forEach(({ name, absAmt }) => {
    let cat = 'Other';
    for (const [catName, pats] of Object.entries(PAYPAL_CATS)) {
      if (pats.some(p => p.test(name))) { cat = catName; break; }
    }
    if (!catTotals[cat]) catTotals[cat] = { t: 0, ct: 0 };
    catTotals[cat].t += absAmt;
    catTotals[cat].ct += 1;
  });

  const ppCats = Object.entries(catTotals)
    .sort((a, b) => b[1].t - a[1].t)
    .map(([n, { t, ct }]) => ({ n, t: Math.round(t), ct, c: PAYPAL_CAT_COLORS[n] || '#94a3b8' }));

  return { ppM, ppCats, rowCount: withDates.length };
}

// ─── GATEWAY BANK ────────────────────────────────────────────────────────────
function processGatewayLoan(rows) {
  if (!rows || rows.length === 0) return {};
  const sample = rows[0];
  const dateCol = findCol(sample, ['entered date', 'transaction date', 'value date', 'date', 'effective date']);
  const balCol  = findCol(sample, ['balance', 'closing balance', 'running balance']);
  if (!balCol) return {};
  if (!dateCol) return {};

  const byMonth = {};
  rows.forEach(r => {
    const date = parseDate(r[dateCol] || '');
    if (!date) return;
    const bal = parseAmount(r[balCol]);
    if (!bal) return;
    const mk = monthKeyYY(date);
    if (!byMonth[mk] || date >= byMonth[mk].date) {
      byMonth[mk] = { date, bal: Math.abs(bal) };
    }
  });

  return Object.fromEntries(Object.entries(byMonth).map(([k, v]) => [k, Math.round(v.bal)]));
}

export function processGateway(mainRows, topRows) {
  const mainByMonth = processGatewayLoan(mainRows);
  const topByMonth  = processGatewayLoan(topRows);

  const allMonths = new Set([...Object.keys(mainByMonth), ...Object.keys(topByMonth)]);
  if (allMonths.size === 0) return null;

  const sorted = Array.from(allMonths).sort((a, b) => {
    const parse = s => { const [mo, yr] = s.split("'"); return parseInt('20' + yr) * 12 + MONTH_NAMES.indexOf(mo); };
    return parse(a) - parse(b);
  });

  const mortBal = sorted.map(m => ({ m, main: mainByMonth[m] || 0, top: topByMonth[m] || 0 }));
  return { mortBal, rowCount: (mainRows?.length || 0) + (topRows?.length || 0) };
}

// ─── COMMSEC ─────────────────────────────────────────────────────────────────
const POS_COLORS = ['#34d399', '#60a5fa', '#fbbf24', '#14b8a6', '#a78bfa', '#fb923c'];
const NEG_COLORS = ['#f87171', '#ef4444', '#fb923c'];

export function processCommSec(rows) {
  if (!rows || rows.length === 0) return null;

  // CommSec CSVs have a title row before the real headers — detect and skip it
  let workRows = rows;
  if (!findCol(rows[0], ['security code', 'code', 'ticker'])) {
    for (let i = 0; i < Math.min(4, rows.length); i++) {
      const vals = Object.values(rows[i]);
      if (vals.some(v => /^code$/i.test((v || '').trim()))) {
        const realHeaders = vals.map(v => (v || '').trim());
        workRows = rows.slice(i + 1).map(r => {
          const values = Object.values(r);
          const row = {};
          realHeaders.forEach((h, idx) => { if (h) row[h] = (values[idx] || '').trim(); });
          return row;
        });
        break;
      }
    }
  }

  const sample = workRows[0];
  if (!sample) return null;

  const codeCol  = findCol(sample, ['security code', 'code', 'ticker']);
  const valueCol = findCol(sample, ['mkt value $', 'market value', 'mkt value', 'value', 'market val', 'value (aud)', 'current value']);
  const plCol    = findCol(sample, ['profit/loss $', 'open p/l ($)', 'unrealised p/l', 'p/l ($)', 'gain/loss', 'gain/loss (aud)', 'unrealised p/l (aud)', 'profit/loss']);

  if (!codeCol || !valueCol) return null;

  const SKIP_CODES = new Set(['total', 'chess', 'issuer sponsored', 'grand total', '']);
  const holdings = workRows.map(r => {
    const code = (r[codeCol] || '').trim();
    if (SKIP_CODES.has(code.toLowerCase())) return null;
    const value = parseAmount(r[valueCol]);
    if (value <= 0) return null;
    const pl = plCol ? parseAmount(r[plCol]) : 0;
    return { code, value, pl };
  }).filter(Boolean);

  if (holdings.length === 0) return null;

  const totalValue = holdings.reduce((s, h) => s + h.value, 0);
  let posIdx = 0, negIdx = 0;

  const shares = holdings.map(h => ({
    code:  h.code,
    value: Math.round(h.value),
    pl:    Math.round(h.pl),
    pct:   parseFloat((h.value / totalValue * 100).toFixed(1)),
    color: h.pl >= 0 ? (POS_COLORS[posIdx++] || '#34d399') : (NEG_COLORS[negIdx++] || '#f87171'),
  }));

  return { shares, rowCount: shares.length };
}
