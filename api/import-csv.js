// api/import-csv.js
// Parses trade CSV files from Tradovate, NinjaTrader, TopstepX, MetaTrader 4/5
// Returns normalized trades in Pattro format ready for Supabase insert

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { csv, broker, account_id, user_id } = req.body || {};

  if (!csv || !account_id || !user_id) {
    return res.status(400).json({ error: 'Missing csv, account_id or user_id' });
  }

  // Verify account belongs to user
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  const accResp = await fetch(
    `${SUPABASE_URL}/rest/v1/accounts?id=eq.${encodeURIComponent(account_id)}&user_id=eq.${encodeURIComponent(user_id)}&select=id`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  const accData = await accResp.json();
  if (!accData || !accData.length) {
    return res.status(403).json({ error: 'Account not found or unauthorized' });
  }

  try {
    // Auto-detect broker if not specified
    const detectedBroker = broker || detectBroker(csv);
    if (!detectedBroker) {
      return res.status(400).json({ error: 'Could not detect broker format. Supported: Tradovate, NinjaTrader, TopstepX, MetaTrader 4/5' });
    }

    // Parse CSV into normalized trades
    let trades = [];
    if (detectedBroker === 'ninjatrader') {
      trades = parseNinjaTrader(csv);
    } else if (detectedBroker === 'tradovate' || detectedBroker === 'topstepx') {
      trades = parseTradovate(csv);
    } else if (detectedBroker === 'metatrader4') {
      trades = parseMetaTrader4(csv);
    } else if (detectedBroker === 'metatrader5') {
      trades = parseMetaTrader5(csv);
    }

    if (!trades.length) {
      return res.status(400).json({ error: 'No trades found in file. Check the format and try again.' });
    }

    // Add account/user context to each trade
    const payload = trades.map(t => ({
      ...t,
      account_id: account_id,
      user_id:    user_id,
      source:     detectedBroker,
      emotion:    t.emotion || 'neutral',
    }));

    // Insert into Supabase (skip duplicates by entry_time + ticker + account_id)
    const insertResp = await fetch(`${SUPABASE_URL}/rest/v1/trades`, {
      method:  'POST',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=ignore-duplicates,return=representation'
      },
      body: JSON.stringify(payload)
    });

    if (!insertResp.ok) {
      const err = await insertResp.text();
      console.error('[import-csv] Supabase insert error:', err);
      return res.status(500).json({ error: 'Failed to save trades: ' + err });
    }

    const inserted = await insertResp.json();

    return res.status(200).json({
      ok:       true,
      broker:   detectedBroker,
      parsed:   trades.length,
      inserted: inserted.length,
      skipped:  trades.length - inserted.length,
    });

  } catch (e) {
    console.error('[import-csv] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// ── BROKER AUTO-DETECTION ──
function detectBroker(csv) {
  const header = csv.split('\n')[0].toLowerCase();
  if (header.includes('market pos.') || header.includes('entry price') && header.includes('exit price') && header.includes('trade #')) return 'ninjatrader';
  if (header.includes('buy/sell') && header.includes('trade time')) return 'tradovate';
  if (header.includes('side') && header.includes('order id') && header.includes('realized p&l')) return 'topstepx';
  if (header.includes('open time') && header.includes('ticket') && header.includes('swap')) return 'metatrader4';
  if (header.includes('position') && header.includes('volume') && header.includes('swap')) return 'metatrader5';
  // Fallback: try tradovate-style
  if (header.includes('buy/sell') || header.includes('qty') && header.includes('symbol')) return 'tradovate';
  return null;
}

// ── CSV PARSER HELPER ──
function parseCSV(text) {
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };

  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
  const rows = lines.slice(1).map(line => {
    // Handle quoted fields with commas inside
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { inQuotes = !inQuotes; continue; }
      if (line[i] === ',' && !inQuotes) { fields.push(current.trim()); current = ''; continue; }
      current += line[i];
    }
    fields.push(current.trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = fields[i] || ''; });
    return row;
  });

  return { headers, rows };
}

function parseFloat2(v) { return parseFloat((v || '').replace(/[$,\s]/g, '')) || 0; }
function parseInt2(v)   { return parseInt((v || '').replace(/[,\s]/g, ''))   || 1; }

// ── NINJATRADER PARSER ──
// Format: Trade #, Instrument, Account, Strategy, Market pos., Qty, Entry price, Exit price,
//         Entry time, Exit time, Duration, Profit, Cum. profit, Commission, MAE, MFE, ETD
function parseNinjaTrader(csv) {
  const { rows } = parseCSV(csv);
  const trades = [];

  for (const row of rows) {
    const side = (row['market pos.'] || '').toLowerCase();
    if (!side || (!side.includes('long') && !side.includes('short'))) continue;

    const profit     = parseFloat2(row['profit']);
    const commission = parseFloat2(row['commission']);
    const entryTime  = parseNinjaDate(row['entry time'] || '');

    if (!entryTime) continue;

    trades.push({
      ticker:      cleanSymbol(row['instrument'] || ''),
      side:        side.includes('long') ? 'long' : 'short',
      quantity:    parseInt2(row['qty']),
      entry_price: parseFloat2(row['entry price']),
      exit_price:  parseFloat2(row['exit price']),
      pnl:         profit - Math.abs(commission),
      entry_time:  entryTime,
      notes:       row['strategy'] ? 'Strategy: ' + row['strategy'] : null,
    });
  }
  return trades;
}

function parseNinjaDate(str) {
  if (!str) return null;
  // Format: 12/1/2024 9:30:00 AM
  try {
    const d = new Date(str);
    if (isNaN(d)) return null;
    return d.toISOString();
  } catch { return null; }
}

// ── TRADOVATE / TOPSTEPX PARSER ──
// Format: Buy/Sell, Qty, Symbol, Price, Commission, P&L, Trade Time, Order Id, Account
// These are fills — need to pair Buy + Sell fills to create complete trades
function parseTradovate(csv) {
  const { rows } = parseCSV(csv);
  const trades   = [];
  const opens    = {}; // symbol -> stack of open fills

  // Sort by time
  const sorted = rows.filter(r => r['symbol'] || r['buy/sell']).sort((a, b) => {
    const ta = new Date(a['trade time'] || a['time'] || 0);
    const tb = new Date(b['trade time'] || b['time'] || 0);
    return ta - tb;
  });

  for (const row of sorted) {
    const side   = (row['buy/sell'] || row['side'] || '').toLowerCase();
    const symbol = cleanSymbol(row['symbol'] || '');
    const price  = parseFloat2(row['price']);
    const qty    = parseInt2(row['qty'] || row['quantity']);
    const pnl    = parseFloat2(row['p&l'] || row['realized p&l'] || '0');
    const comm   = parseFloat2(row['commission'] || '0');
    const time   = parseTradovateDate(row['trade time'] || row['time'] || '');

    if (!symbol || !time || !side) continue;

    if (!opens[symbol]) opens[symbol] = [];

    if (side === 'buy') {
      opens[symbol].push({ price, qty, time, comm });
    } else if (side === 'sell' && opens[symbol].length) {
      const open = opens[symbol].shift();
      trades.push({
        ticker:      symbol,
        side:        'long', // buy then sell = long
        quantity:    Math.min(open.qty, qty),
        entry_price: open.price,
        exit_price:  price,
        pnl:         pnl ? pnl - Math.abs(comm) - Math.abs(open.comm) : 0,
        entry_time:  open.time,
      });
    } else if (side === 'sell') {
      // Short trade — sell first
      opens[symbol].push({ price, qty, time, comm, short: true });
    } else if (side === 'buy' && opens[symbol].length && opens[symbol][0].short) {
      const open = opens[symbol].shift();
      trades.push({
        ticker:      symbol,
        side:        'short',
        quantity:    Math.min(open.qty, qty),
        entry_price: open.price,
        exit_price:  price,
        pnl:         pnl ? pnl - Math.abs(comm) - Math.abs(open.comm) : 0,
        entry_time:  open.time,
      });
    }
  }

  return trades;
}

function parseTradovateDate(str) {
  if (!str) return null;
  try {
    const d = new Date(str);
    if (isNaN(d)) return null;
    return d.toISOString();
  } catch { return null; }
}

// ── METATRADER 4 PARSER ──
// Format: Ticket, Open Time, Type, Size, Symbol, Price, S/L, T/P, Close Time, Price, Commission, Swap, Profit
function parseMetaTrader4(csv) {
  const { rows } = parseCSV(csv);
  const trades   = [];

  for (const row of rows) {
    const type = (row['type'] || '').toLowerCase();
    if (!type.includes('buy') && !type.includes('sell')) continue;

    // Skip pending orders, balance entries
    if (type.includes('limit') || type.includes('stop') || type === 'balance' || type === 'credit') continue;

    const cols       = Object.keys(row);
    const priceKeys  = cols.filter(k => k === 'price');
    const entryPrice = parseFloat2(row['price']);

    // MT4 has two 'price' columns — entry and exit. Take both.
    const rawLine  = Object.values(row).join(',');
    const prices   = rawLine.match(/\d+\.\d{4,5}/g) || [];
    const exitPrice = prices.length >= 2 ? parseFloat(prices[1]) : entryPrice;

    const profit   = parseFloat2(row['profit']);
    const comm     = parseFloat2(row['commission']);
    const swap     = parseFloat2(row['swap']);
    const entryTime = parseMT4Date(row['open time'] || '');

    if (!entryTime) continue;

    // Convert MT4 lot size to contracts
    const size = parseFloat2(row['size']) || 0.01;
    const qty  = Math.round(size * 100); // 0.01 lot = 1 micro unit

    trades.push({
      ticker:      cleanSymbol(row['symbol'] || ''),
      side:        type.startsWith('buy') ? 'long' : 'short',
      quantity:    qty || 1,
      entry_price: entryPrice,
      exit_price:  exitPrice || null,
      pnl:         profit + comm + swap,
      entry_time:  entryTime,
      notes:       row['comment'] || null,
    });
  }

  return trades;
}

function parseMT4Date(str) {
  if (!str) return null;
  // Format: 2024.12.01 09:30 or 2024.12.01 09:30:00
  try {
    const normalized = str.replace(/\./g, '-').replace(' ', 'T');
    const d = new Date(normalized);
    if (isNaN(d)) return null;
    return d.toISOString();
  } catch { return null; }
}

// ── METATRADER 5 PARSER ──
// Format: Position, Symbol, Type, Volume, Price, S/L, T/P, Time, Price, Commission, Swap, Profit
function parseMetaTrader5(csv) {
  const { rows } = parseCSV(csv);
  const trades   = [];

  for (const row of rows) {
    const type = (row['type'] || '').toLowerCase();
    if (!type.includes('buy') && !type.includes('sell')) continue;
    if (type.includes('limit') || type.includes('stop')) continue;

    const profit   = parseFloat2(row['profit']);
    const comm     = parseFloat2(row['commission']);
    const swap     = parseFloat2(row['swap']);
    const entryTime = parseMT4Date(row['time'] || '');

    if (!entryTime) continue;

    trades.push({
      ticker:      cleanSymbol(row['symbol'] || ''),
      side:        type.startsWith('buy') ? 'long' : 'short',
      quantity:    Math.round((parseFloat2(row['volume']) || 0.01) * 100) || 1,
      entry_price: parseFloat2(row['price']),
      exit_price:  null, // MT5 deals don't always include close price in same row
      pnl:         profit + comm + swap,
      entry_time:  entryTime,
    });
  }

  return trades;
}

// ── HELPERS ──
function cleanSymbol(sym) {
  // Remove expiry suffixes: NQZ4 -> NQ, ESH25 -> ES, EURUSD stays EURUSD
  return sym.replace(/[A-Z]{1,2}\d{1,2}$/, '') || sym;
}
