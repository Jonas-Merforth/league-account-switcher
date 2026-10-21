// Heuristics for investigation, never a gameplay trigger. Unknown wording stays unknown.
export const FF_WORD = /surrender|forfeit|concede|\bff\b|vote/i;
const SECRET_KEY = /token|password|authorization|credential|encryption|secret|cookie/i;
const IDENTITY_KEY = /^(puuid|summonerId|accountId|summonerName|riotId.*|gameName|displayName|playerName|killerName|victimName|assisters|acer)$/i;

export function sanitizeResearch(value, depth = 0) {
  if (depth > 40) return '[research depth limit: omitted]';
  if (typeof value === 'string') return value
    .replace(/(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.\-]+/gi, '[credential removed]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[token removed]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id removed]');
  // Do not truncate delta arrays: every operation is needed to reconstruct a snapshot.
  // Network responses and the entire recording have separate explicit byte limits.
  if (Array.isArray(value)) return value.map((item) => sanitizeResearch(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, SECRET_KEY.test(key) || IDENTITY_KEY.test(key) ? '[removed]' : sanitizeResearch(item, depth + 1)]));
  return value ?? null;
}

export function normalizeResearchTeam(team) {
  if ([100, '100', 'ORDER', 'BLUE'].includes(team)) return 'ORDER';
  if ([200, '200', 'CHAOS', 'RED'].includes(team)) return 'CHAOS';
  return null;
}

export function classifyFFEvidence(label, data = {}, localTeam = null) {
  data = data && typeof data === 'object' ? data : {};
  const text = String(label || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const declared = normalizeResearchTeam(data.Team ?? data.team ?? data.TeamId ?? data.teamId);
  const local = normalizeResearchTeam(localTeam);
  const words = String(label || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  const side = /enemy|opponent/.test(text) ? 'enemy'
    : /\bally\b|\ballied\b|myteam|ourteam/.test(words.replace(/my team/g, 'myteam').replace(/our team/g, 'ourteam')) ? 'ally'
      : declared && local ? (declared === local ? 'ally' : 'enemy') : 'unknown';
  let stage = 'unknown';
  if (/gameend|endofgame|preendofgame|nexusdestroy/.test(text) && !/surrender/.test(text)) stage = 'game-end';
  else if (/surrender|forfeit|concede/.test(text)) {
    if (/failed|rejected|cancelled|canceled|denied/.test(text)) stage = 'vote-failed';
    else if (/agreed|accepted|passed|success|gameendedin/.test(text)) stage = 'surrender-accepted';
    else if (/start|initiat|begin|called|opened/.test(text)) stage = 'vote-start';
    else if (/progress|update|cast|voting/.test(text)
      || Object.keys(data).some((key) => /^(forVotes|againstVotes|yesVotes|noVotes|votesFor|votesAgainst)$/i.test(key))) stage = 'vote-progress';
  }
  // A false status flag is not an occurrence. Static field discovery isn't a signal either.
  if (Object.hasOwn(data, 'value') && [false, null, '', 0].includes(data.value)) stage = 'unknown';
  return { stage, side, confidence: stage === 'unknown' ? 'unclassified' : 'candidate' };
}

// Inspect fields even if the documented API never mentions them. Keep the enclosing team,
// rather than guessing it from a winner, an array position, or the active player's team.
export function findFFFields(value, prefix = '', parentTeam = null, depth = 0, output = []) {
  // Several client buses carry their payload as JSON text. Decode only bounded JSON
  // objects/arrays; never search arbitrary chat/prose strings for "ff".
  if (typeof value === 'string' && value.length <= 65536 && /^[\s]*[\[{]/.test(value)) {
    try { value = JSON.parse(value); } catch { return output; }
  }
  if (!value || typeof value !== 'object' || depth > 8 || output.length >= 100) return output;
  const team = normalizeResearchTeam(value.Team ?? value.team ?? value.TeamId ?? value.teamId) || parentTeam;
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key) || IDENTITY_KEY.test(key)) continue;
    const field = prefix ? `${prefix}.${key}` : key;
    if (FF_WORD.test(key)) {
      // Decode a JSON-valued FF field before redaction as well.
      let decoded = item;
      if (typeof item === 'string' && item.length <= 65536 && /^[\s]*[\[{]/.test(item)) {
        try { decoded = JSON.parse(item); } catch { /* retain scalar */ }
      }
      output.push({ field, value: decoded, team });
    } else if (/^(eventName|eventType|messageType|notificationType|methodName|type|name)$/i.test(key)
      && typeof item === 'string' && /^[A-Za-z0-9_.:/-]{1,180}$/.test(item) && FF_WORD.test(item)) {
      output.push({ field: `${field}:${item}`, value: item, team });
    } else if (item && (typeof item === 'object' || typeof item === 'string')) findFFFields(item, field, team, depth + 1, output);
    if (output.length >= 100) break;
  }
  return output;
}

export function discoverFFRoutes(schema) {
  return Object.entries(schema?.paths || {}).filter(([route]) => FF_WORD.test(route)).map(([route, methods]) => ({
    route,
    methods: Object.keys(methods).filter((method) => /^(get|post|put|patch|delete)$/i.test(method)),
    // Discovery only. Never call a newly found route automatically.
    description: String(methods?.get?.summary || methods?.post?.summary || '').slice(0, 250)
  }));
}

// Reconstructable changes preserve fields we have not learned to recognize yet, without
// writing the same roster, item descriptions and ability text every two seconds.
export function researchChanges(before, after, path = [], changes = []) {
  if (JSON.stringify(before) === JSON.stringify(after)) return changes;
  if (before && after && typeof before === 'object' && typeof after === 'object'
    && Array.isArray(before) === Array.isArray(after)
    && (!Array.isArray(before) || before.length === after.length)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!Object.hasOwn(after, key)) changes.push({ op: 'remove', path: [...path, key] });
      else researchChanges(before[key], after[key], [...path, key], changes);
    }
  } else changes.push({ op: 'set', path, value: after });
  return changes;
}

export function summarizeFFTiming(rows, matchIndex) {
  const current = rows.filter((row) => row.matchIndex === matchIndex);
  const start = [...current].reverse().find((row) => row.kind === 'marker' && row.stage === 'vote-start' && row.side === 'enemy');
  const decision = current.find((row) => row.kind === 'marker' && row.stage === 'surrender-accepted'
    && row.side === 'enemy' && (!start || row.elapsedMs >= start.elapsedMs));
  const candidates = current.filter((row) => row.kind === 'candidate' && !row.historical
    && row.side === 'enemy' && ['vote-start', 'vote-progress'].includes(row.stage)
    && (!start || row.elapsedMs >= start.elapsedMs) && (!decision || row.elapsedMs < decision.elapsedMs));
  const first = candidates[0];
  return {
    candidateCount: candidates.length,
    firstCandidateId: first?.id ?? null,
    startMarkerId: start?.id ?? null,
    decisionMarkerId: decision?.id ?? null,
    observedLeadMs: first && decision ? Math.round(decision.elapsedMs - first.elapsedMs) : null,
    verdict: first ? 'Candidate needs verification' : 'No early enemy signal observed',
    note: 'Arrival order only. Manual markers include human reaction delay; this is not server timing or proof.'
  };
}
