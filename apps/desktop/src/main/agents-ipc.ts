import { CodesignError } from '@open-codesign/shared';
import type BetterSqlite3 from 'better-sqlite3';
import { ipcMain } from 'electron';
import {
  bulkArchiveAgentRuns,
  createAgentRun,
  getAgentRun,
  listAgentRuns,
  reconcileStaleRunningAgentRuns,
  switchAgentRun,
  updateAgentRunMeta,
} from './snapshots-db';

type Database = BetterSqlite3.Database;

function requireSchemaV1(raw: Record<string, unknown>, channel: string): void {
  if (raw.schemaVersion !== 1) {
    throw new CodesignError(`${channel} schemaVersion must be 1`, 'IPC_BAD_INPUT');
  }
}

export function registerAgentsIpc(db: Database): void {
  reconcileStaleRunningAgentRuns(db, Date.now(), 120_000);

  ipcMain.handle('agents:v1:list', (_e, raw: unknown) => {
    if (!raw || typeof raw !== 'object')
      throw new CodesignError('agents:v1:list expects object payload', 'IPC_BAD_INPUT');
    const r = raw as Record<string, unknown>;
    requireSchemaV1(r, 'agents:v1:list');
    return listAgentRuns(db, {
      includeArchived: r.includeArchived === true,
      status: typeof r.status === 'string' ? r.status : 'all',
      search: typeof r.search === 'string' ? r.search : '',
      limit: typeof r.limit === 'number' ? r.limit : 50,
      cursor: typeof r.cursor === 'string' ? r.cursor : null,
    });
  });

  ipcMain.handle('agents:v1:create', (_e, raw: unknown) => {
    if (!raw || typeof raw !== 'object')
      throw new CodesignError('agents:v1:create expects object payload', 'IPC_BAD_INPUT');
    const r = raw as Record<string, unknown>;
    requireSchemaV1(r, 'agents:v1:create');
    return createAgentRun(db, {
      name: typeof r.name === 'string' ? r.name : undefined,
      mode: r.mode === 'game' || r.mode === 'motion' ? r.mode : 'design',
      initialPrompt: typeof r.initialPrompt === 'string' ? r.initialPrompt : undefined,
      switchToNew: r.switchToNew === true,
    });
  });

  ipcMain.handle('agents:v1:get', (_e, raw: unknown) => {
    if (!raw || typeof raw !== 'object')
      throw new CodesignError('agents:v1:get expects object payload', 'IPC_BAD_INPUT');
    const r = raw as Record<string, unknown>;
    requireSchemaV1(r, 'agents:v1:get');
    if (typeof r.designId !== 'string')
      throw new CodesignError('agents:v1:get designId required', 'IPC_BAD_INPUT');
    return getAgentRun(db, r.designId);
  });

  ipcMain.handle('agents:v1:update-meta', (_e, raw: unknown) => {
    if (!raw || typeof raw !== 'object')
      throw new CodesignError('agents:v1:update-meta expects object payload', 'IPC_BAD_INPUT');
    const r = raw as Record<string, unknown>;
    requireSchemaV1(r, 'agents:v1:update-meta');
    if (typeof r.designId !== 'string')
      throw new CodesignError('agents:v1:update-meta designId required', 'IPC_BAD_INPUT');
    return updateAgentRunMeta(db, r.designId, {
      pinned: typeof r.pinned === 'boolean' ? r.pinned : undefined,
      archived: typeof r.archived === 'boolean' ? r.archived : undefined,
      agentLabel: typeof r.agentLabel === 'string' ? r.agentLabel : undefined,
    });
  });

  ipcMain.handle('agents:v1:switch', (_e, raw: unknown) => {
    if (!raw || typeof raw !== 'object')
      throw new CodesignError('agents:v1:switch expects object payload', 'IPC_BAD_INPUT');
    const r = raw as Record<string, unknown>;
    requireSchemaV1(r, 'agents:v1:switch');
    if (typeof r.designId !== 'string')
      throw new CodesignError('agents:v1:switch designId required', 'IPC_BAD_INPUT');
    return switchAgentRun(db, r.designId);
  });

  ipcMain.handle('agents:v1:bulk-archive', (_e, raw: unknown) => {
    if (!raw || typeof raw !== 'object')
      throw new CodesignError('agents:v1:bulk-archive expects object payload', 'IPC_BAD_INPUT');
    const r = raw as Record<string, unknown>;
    requireSchemaV1(r, 'agents:v1:bulk-archive');
    if (!Array.isArray(r.designIds))
      throw new CodesignError('agents:v1:bulk-archive designIds required', 'IPC_BAD_INPUT');
    return bulkArchiveAgentRuns(
      db,
      r.designIds.filter((id): id is string => typeof id === 'string'),
    );
  });
}
