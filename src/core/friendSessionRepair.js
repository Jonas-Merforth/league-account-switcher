import fs from 'node:fs';
import path from 'node:path';
import { SNAPSHOT_ITEMS, writeSessionBundle } from './sessionBundle.js';

export function replaceLiveSessionBundle(root, manifest) {
  for (const item of SNAPSHOT_ITEMS) {
    fs.rmSync(path.join(root, ...item.rel.split('/')), { recursive: true, force: true });
  }
  writeSessionBundle(manifest, root);
}

export function friendRepairRestoreOptions({ leagueWasRunning = false, lobbyRejoinTarget = null } = {}) {
  return {
    force: false,
    forceLogin: false,
    clientOnly: !leagueWasRunning,
    repairOnly: !leagueWasRunning,
    lobbyRejoinTarget: leagueWasRunning ? lobbyRejoinTarget : null
  };
}

export function shouldCountLoginDuringFriendRepair(repairBusy) {
  return !repairBusy;
}

export async function runSequentialFriendRepairs(accountIds, {
  repair,
  validate,
  restore,
  progress = () => {}
}) {
  const ids = [...new Set((accountIds || []).map(String).filter(Boolean))];
  const fixed = [];
  const failed = [];
  let restoration = { restored: false, reason: '' };

  try {
    for (const [index, accountId] of ids.entries()) {
      progress({ phase: 'account-start', accountId, accountIndex: index + 1, accountTotal: ids.length });
      let label = accountId;
      try {
        const repaired = await repair(accountId, { index, total: ids.length });
        label = repaired?.label || label;
        const validation = await validate(accountId, repaired);
        const result = { accountId, label: repaired?.label || validation?.label || label, validation };
        fixed.push(result);
        progress({ phase: 'account-done', ...result, accountIndex: index + 1, accountTotal: ids.length });
      } catch (error) {
        const result = { accountId, label: error?.label || label, error: error?.message || String(error) };
        failed.push(result);
        progress({ phase: 'account-error', ...result, accountIndex: index + 1, accountTotal: ids.length });
      }
    }
  } finally {
    progress({ phase: 'restoring', accountTotal: ids.length, fixedCount: fixed.length, failedCount: failed.length });
    try {
      restoration = await restore({ fixed, failed });
    } catch (error) {
      restoration = { restored: false, reason: error?.message || String(error) };
    }
  }

  const result = { fixed, failed, restoration };
  progress({ phase: 'repair-done', ...result, accountTotal: ids.length, fixedCount: fixed.length, failedCount: failed.length });
  return result;
}
