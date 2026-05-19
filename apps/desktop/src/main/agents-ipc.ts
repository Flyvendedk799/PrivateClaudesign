import { CodesignError, ERROR_CODES } from '@open-codesign/shared';
import type BetterSqlite3 from 'better-sqlite3';
import { ipcMain } from './electron-runtime';
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
type AgentMode = NonNullable<Parameters<typeof createAgentRun>[1]['mode']>;
type CreateAgentRunInput = Parameters<typeof createAgentRun>[1];
type UpdateAgentRunMetaPatch = Parameters<typeof updateAgentRunMeta>[2];

function asRecord(raw: unknown, channel: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) {
    throw new CodesignError(`${channel} expects object payload`, ERROR_CODES.IPC_BAD_INPUT);
  }
  return raw as Record<string, unknown>;
}

function requireSchemaV1(raw: Record<string, unknown>, channel: string): void {
  if (raw['schemaVersion'] !== 1) {
    throw new CodesignError(`${channel} schemaVersion must be 1`, ERROR_CODES.IPC_BAD_INPUT);
  }
}

function requireString(raw: Record<string, unknown>, key: string, channel: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CodesignError(`${channel} ${key} required`, ERROR_CODES.IPC_BAD_INPUT);
  }
  return value;
}

function safeAgentMode(value: unknown): AgentMode {
  return value === 'game' || value === 'motion' ? value : 'design';
}

export function registerAgentsIpc(db: Database): void {
  reconcileStaleRunningAgentRuns(db, Date.now(), 120_000);

  ipcMain.handle('agents:v1:list', (_e, raw: unknown) => {
    const r = asRecord(raw, 'agents:v1:list');
    requireSchemaV1(r, 'agents:v1:list');
    return listAgentRuns(db, {
      includeArchived: r['includeArchived'] === true,
      status: typeof r['status'] === 'string' ? r['status'] : 'all',
      search: typeof r['search'] === 'string' ? r['search'] : '',
      limit: typeof r['limit'] === 'number' ? r['limit'] : 50,
      cursor: typeof r['cursor'] === 'string' ? r['cursor'] : null,
    });
  });

  ipcMain.handle('agents:v1:create', (_e, raw: unknown) => {
    const r = asRecord(raw, 'agents:v1:create');
    requireSchemaV1(r, 'agents:v1:create');
    const input: CreateAgentRunInput = {
      mode: safeAgentMode(r['mode']),
      switchToNew: r['switchToNew'] === true,
    };
    if (typeof r['name'] === 'string') input.name = r['name'];
    if (typeof r['initialPrompt'] === 'string') input.initialPrompt = r['initialPrompt'];
    return createAgentRun(db, input);
  });

  ipcMain.handle('agents:v1:get', (_e, raw: unknown) => {
    const r = asRecord(raw, 'agents:v1:get');
    requireSchemaV1(r, 'agents:v1:get');
    const designId = requireString(r, 'designId', 'agents:v1:get');
    return getAgentRun(db, designId);
  });

  ipcMain.handle('agents:v1:update-meta', (_e, raw: unknown) => {
    const r = asRecord(raw, 'agents:v1:update-meta');
    requireSchemaV1(r, 'agents:v1:update-meta');
    const designId = requireString(r, 'designId', 'agents:v1:update-meta');
    const patch: UpdateAgentRunMetaPatch = {};
    if (typeof r['pinned'] === 'boolean') patch.pinned = r['pinned'];
    if (typeof r['archived'] === 'boolean') patch.archived = r['archived'];
    if (typeof r['agentLabel'] === 'string') patch.agentLabel = r['agentLabel'];
    return updateAgentRunMeta(db, designId, patch);
  });

  ipcMain.handle('agents:v1:switch', (_e, raw: unknown) => {
    const r = asRecord(raw, 'agents:v1:switch');
    requireSchemaV1(r, 'agents:v1:switch');
    const designId = requireString(r, 'designId', 'agents:v1:switch');
    return switchAgentRun(db, designId);
  });

  ipcMain.handle('agents:v1:bulk-archive', (_e, raw: unknown) => {
    const r = asRecord(raw, 'agents:v1:bulk-archive');
    requireSchemaV1(r, 'agents:v1:bulk-archive');
    const designIds = r['designIds'];
    if (!Array.isArray(designIds))
      throw new CodesignError(
        'agents:v1:bulk-archive designIds required',
        ERROR_CODES.IPC_BAD_INPUT,
      );
    return bulkArchiveAgentRuns(
      db,
      designIds.filter((id): id is string => typeof id === 'string'),
    );
  });
}
