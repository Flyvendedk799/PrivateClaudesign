/**
 * game-artifacts agent tools — register only when `gameMode.artifactRegistry`
 * deps are provided. Every tool is a thin wrapper around a host-supplied
 * callback so the core stays free of `better-sqlite3` and the implementation
 * can live in `apps/desktop/src/main/game-artifacts-db.ts`.
 *
 * Tools:
 *   - list_game_artifacts
 *   - inspect_game_artifact
 *   - resolve_game_artifact_ref
 *   - create_game_artifact
 *   - update_game_artifact
 *   - bind_animation_to_sprite
 *   - validate_game_artifacts
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

export interface CompactArtifact {
  id: string;
  alias: string;
  name: string;
  slug: string;
  kind: 'sprite' | 'animation';
  primaryFilePath: string | null;
  status: string;
  metadataSummary: string;
}

export interface DetailedArtifact extends CompactArtifact {
  metadata: Record<string, unknown>;
  files: Array<{ path: string; role: string }>;
  bindings?: Array<{ animationId: string; spriteId: string; bindingStatus: string }>;
}

export interface GameArtifactRegistryDeps {
  list: (filter: {
    kind?: 'sprite' | 'animation';
    includeArchived?: boolean;
  }) => Promise<CompactArtifact[]> | CompactArtifact[];
  inspect: (artifactId: string) => Promise<DetailedArtifact | null> | DetailedArtifact | null;
  resolveRef: (
    text: string,
    expectedKind?: 'sprite' | 'animation',
  ) => Promise<DetailedArtifact | null> | DetailedArtifact | null;
  create: (input: {
    kind: 'sprite' | 'animation';
    name: string;
    metadata: Record<string, unknown>;
    primaryFilePath?: string;
    fileRefs?: Array<{ path: string; role: string }>;
  }) => Promise<DetailedArtifact> | DetailedArtifact;
  update: (input: {
    artifactId: string;
    name?: string;
    metadataPatch?: Record<string, unknown>;
    primaryFilePath?: string;
    status?: 'ready' | 'generating' | 'error' | 'archived';
    fileRefsAdd?: Array<{ path: string; role: string }>;
    fileRefsRemove?: string[];
  }) => Promise<DetailedArtifact> | DetailedArtifact;
  bindAnimation: (input: {
    animationId: string;
    spriteId: string;
    bindingStatus?: 'compatible' | 'needs_retarget' | 'broken';
    retarget?: unknown;
  }) =>
    | Promise<{ animationId: string; spriteId: string }>
    | { animationId: string; spriteId: string };
  validate: () =>
    | Promise<{
        issues: Array<{ artifactId?: string; severity: 'error' | 'warn'; message: string }>;
      }>
    | {
        issues: Array<{ artifactId?: string; severity: 'error' | 'warn'; message: string }>;
      };
}

const ListParams = Type.Object({
  kind: Type.Optional(
    Type.Union([Type.Literal('sprite'), Type.Literal('animation')], {
      description: 'Filter to sprites or animations only. Omit for both.',
    }),
  ),
  includeArchived: Type.Optional(
    Type.Boolean({
      description: 'When true, includes archived artifacts. Defaults to false.',
    }),
  ),
});

const InspectParams = Type.Object({
  artifactId: Type.String({ description: 'Artifact id (returned by list/create/resolve_ref).' }),
});

const ResolveParams = Type.Object({
  text: Type.String({
    description:
      'Free-form mention from the user — e.g. "@sprite:hero-knight", "the selected sprite", or "Hero Knight". Resolver matches alias, slug, or display name in that order.',
  }),
  expectedKind: Type.Optional(Type.Union([Type.Literal('sprite'), Type.Literal('animation')])),
});

const CreateParams = Type.Object({
  kind: Type.Union([Type.Literal('sprite'), Type.Literal('animation')]),
  name: Type.String({ description: 'Human-readable name. The slug is derived from this.' }),
  metadata: Type.Object(
    {},
    {
      description:
        'Sprite or animation metadata. Must include kind, version=1, and the kind-specific fields (e.g. visualType for sprites, animationType + durationMs for animations).',
      additionalProperties: true,
    },
  ),
  primaryFilePath: Type.Optional(Type.String()),
  fileRefs: Type.Optional(
    Type.Array(
      Type.Object({
        path: Type.String(),
        role: Type.String({
          description:
            'One of: source, texture, spritesheet, atlas, model, rig, animation, thumbnail, preview, metadata, derived.',
        }),
      }),
    ),
  ),
});

const UpdateParams = Type.Object({
  artifactId: Type.String(),
  name: Type.Optional(Type.String()),
  metadataPatch: Type.Optional(Type.Object({}, { additionalProperties: true })),
  primaryFilePath: Type.Optional(Type.String()),
  status: Type.Optional(
    Type.Union([
      Type.Literal('ready'),
      Type.Literal('generating'),
      Type.Literal('error'),
      Type.Literal('archived'),
    ]),
  ),
  fileRefsAdd: Type.Optional(Type.Array(Type.Object({ path: Type.String(), role: Type.String() }))),
  fileRefsRemove: Type.Optional(Type.Array(Type.String())),
});

const BindParams = Type.Object({
  animationId: Type.String(),
  spriteId: Type.String(),
  bindingStatus: Type.Optional(
    Type.Union([
      Type.Literal('compatible'),
      Type.Literal('needs_retarget'),
      Type.Literal('broken'),
    ]),
  ),
  retarget: Type.Optional(Type.Object({}, { additionalProperties: true })),
});

const ValidateParams = Type.Object({});

function summarize(a: CompactArtifact): string {
  return `${a.alias} (${a.kind}) → ${a.primaryFilePath ?? '(no primary file)'}`;
}

export function makeListGameArtifactsTool(
  deps: GameArtifactRegistryDeps,
): AgentTool<typeof ListParams, { count: number }> {
  return {
    name: 'list_game_artifacts',
    label: 'List game artifacts',
    description:
      'List sprite and animation artifacts in the current game project. Returns aliases, slugs, and primary file paths so subsequent tool calls and code edits can reference them by id.',
    parameters: ListParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<{ count: number }>> {
      const filter: { kind?: 'sprite' | 'animation'; includeArchived?: boolean } = {};
      if (params.kind !== undefined) filter.kind = params.kind;
      if (params.includeArchived === true) filter.includeArchived = true;
      const items = await deps.list(filter);
      const lines = items.length === 0 ? ['(no artifacts yet)'] : items.map(summarize);
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: { count: items.length },
      };
    },
  };
}

export function makeInspectGameArtifactTool(
  deps: GameArtifactRegistryDeps,
): AgentTool<typeof InspectParams, { found: boolean }> {
  return {
    name: 'inspect_game_artifact',
    label: 'Inspect game artifact',
    description:
      'Return full metadata + file refs + binding info for a single artifact. Use this before editing code that depends on an artifact so paths/aliases match the registry exactly.',
    parameters: InspectParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<{ found: boolean }>> {
      const detail = await deps.inspect(params.artifactId);
      if (detail === null) {
        return {
          content: [{ type: 'text', text: `Artifact ${params.artifactId} not found.` }],
          details: { found: false },
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(detail, null, 2),
          },
        ],
        details: { found: true },
      };
    },
  };
}

export function makeResolveGameArtifactRefTool(
  deps: GameArtifactRegistryDeps,
): AgentTool<typeof ResolveParams, { resolved: boolean }> {
  return {
    name: 'resolve_game_artifact_ref',
    label: 'Resolve game artifact reference',
    description:
      'Resolve a free-form artifact reference (alias, slug, or name) to a concrete artifact id. Use when a prompt mentions an artifact by name and you need its id to edit code or bind animations.',
    parameters: ResolveParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<{ resolved: boolean }>> {
      const detail = await deps.resolveRef(params.text, params.expectedKind);
      if (detail === null) {
        return {
          content: [
            {
              type: 'text',
              text: `Could not resolve "${params.text}". Call list_game_artifacts to see what is available, or ask the user to clarify.`,
            },
          ],
          details: { resolved: false },
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(detail, null, 2) }],
        details: { resolved: true },
      };
    },
  };
}

export function makeCreateGameArtifactTool(
  deps: GameArtifactRegistryDeps,
): AgentTool<typeof CreateParams, { artifactId: string }> {
  return {
    name: 'create_game_artifact',
    label: 'Create game artifact',
    description:
      'Register a new sprite or animation in the project registry. Pass the metadata for the kind (sprite: visualType, frameCount, dimensions; animation: animationType, durationMs, loop). File refs link existing design_files paths under assets/sprites/<slug>/ or assets/animations/<slug>/. Animation creation should be paired with bind_animation_to_sprite in the same step.',
    parameters: CreateParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<{ artifactId: string }>> {
      const created = await deps.create({
        kind: params.kind,
        name: params.name,
        metadata: params.metadata,
        ...(params.primaryFilePath !== undefined
          ? { primaryFilePath: params.primaryFilePath }
          : {}),
        ...(params.fileRefs !== undefined ? { fileRefs: params.fileRefs } : {}),
      });
      return {
        content: [
          { type: 'text', text: `Created ${created.alias} (id=${created.id}).` },
          { type: 'text', text: JSON.stringify(created, null, 2) },
        ],
        details: { artifactId: created.id },
      };
    },
  };
}

export function makeUpdateGameArtifactTool(
  deps: GameArtifactRegistryDeps,
): AgentTool<typeof UpdateParams, { artifactId: string }> {
  return {
    name: 'update_game_artifact',
    label: 'Update game artifact',
    description:
      'Refine an existing sprite or animation. Preserves id, slug, and prompt alias. Use to update name, metadata fields, swap the primary file path, or attach/remove file refs after a re-export.',
    parameters: UpdateParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<{ artifactId: string }>> {
      const updated = await deps.update({
        artifactId: params.artifactId,
        ...(params.name !== undefined ? { name: params.name } : {}),
        ...(params.metadataPatch !== undefined ? { metadataPatch: params.metadataPatch } : {}),
        ...(params.primaryFilePath !== undefined
          ? { primaryFilePath: params.primaryFilePath }
          : {}),
        ...(params.status !== undefined ? { status: params.status } : {}),
        ...(params.fileRefsAdd !== undefined ? { fileRefsAdd: params.fileRefsAdd } : {}),
        ...(params.fileRefsRemove !== undefined ? { fileRefsRemove: params.fileRefsRemove } : {}),
      });
      return {
        content: [
          { type: 'text', text: `Updated ${updated.alias}.` },
          { type: 'text', text: JSON.stringify(updated, null, 2) },
        ],
        details: { artifactId: updated.id },
      };
    },
  };
}

export function makeBindAnimationToSpriteTool(
  deps: GameArtifactRegistryDeps,
): AgentTool<typeof BindParams, { animationId: string; spriteId: string }> {
  return {
    name: 'bind_animation_to_sprite',
    label: 'Bind animation to sprite',
    description:
      'Create or update a many-to-many binding between an animation artifact and a sprite artifact. Use after create_game_artifact(kind="animation") so the registry knows which sprites the clip applies to. Status defaults to "compatible".',
    parameters: BindParams,
    async execute(
      _toolCallId,
      params,
    ): Promise<AgentToolResult<{ animationId: string; spriteId: string }>> {
      const result = await deps.bindAnimation({
        animationId: params.animationId,
        spriteId: params.spriteId,
        ...(params.bindingStatus !== undefined ? { bindingStatus: params.bindingStatus } : {}),
        ...(params.retarget !== undefined ? { retarget: params.retarget } : {}),
      });
      return {
        content: [
          {
            type: 'text',
            text: `Bound animation ${result.animationId} to sprite ${result.spriteId}.`,
          },
        ],
        details: result,
      };
    },
  };
}

export function makeValidateGameArtifactsTool(
  deps: GameArtifactRegistryDeps,
): AgentTool<typeof ValidateParams, { issueCount: number }> {
  return {
    name: 'validate_game_artifacts',
    label: 'Validate game artifacts',
    description:
      'Run cross-cutting checks on the artifact registry: every animation has at least one binding, every binding points to existing sprites, every artifact has at least one file ref. Call before `done` on game runs that mutated the registry.',
    parameters: ValidateParams,
    async execute(_toolCallId): Promise<AgentToolResult<{ issueCount: number }>> {
      const result = await deps.validate();
      if (result.issues.length === 0) {
        return {
          content: [{ type: 'text', text: 'No artifact issues detected.' }],
          details: { issueCount: 0 },
        };
      }
      const summary = result.issues
        .map(
          (issue) =>
            `[${issue.severity}] ${issue.artifactId ? `${issue.artifactId}: ` : ''}${issue.message}`,
        )
        .join('\n');
      return {
        content: [{ type: 'text', text: summary }],
        details: { issueCount: result.issues.length },
      };
    },
  };
}
