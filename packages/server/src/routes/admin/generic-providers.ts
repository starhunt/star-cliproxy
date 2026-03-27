import type { FastifyInstance } from 'fastify';
import { eq, like } from 'drizzle-orm';
import type { GenericCliProviderConfig } from '@star-cliproxy/shared';
import { getDatabase } from '../../db/client.js';
import { settings, providerHealth } from '../../db/schema.js';
import type { ProviderRegistry } from '../../providers/provider-registry.js';
import type { HealthChecker } from '../../services/health-checker.js';
import type { QueueManager } from '../../services/queue.js';
import { GenericCliProvider } from '../../providers/generic-cli-provider.js';

// DB 키 접두사
const GENERIC_PROVIDER_PREFIX = 'generic_provider:';
const PROVIDER_CONFIG_PREFIX = 'provider_config:';

// 빌트인 프로바이더 이름 (사용 불가)
const BUILTIN_PROVIDER_NAMES = ['claude', 'codex', 'copilot', 'gemini'];

// 프로바이더 이름 유효성 검사 패턴: 소문자·숫자·하이픈, 길이 2-30
const PROVIDER_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

// cli_path 허용 문자 검사: 영숫자, -, _, ., /, \, :
const SAFE_CLI_PATH = /^[a-zA-Z0-9_\-./\\:]+$/;

function validateProviderName(name: string): string | null {
  if (!PROVIDER_NAME_PATTERN.test(name)) {
    return `Provider name "${name}" is invalid. Use lowercase letters, numbers, and hyphens only (length 2-30).`;
  }
  if (name.length < 2 || name.length > 30) {
    return `Provider name must be between 2 and 30 characters.`;
  }
  return null;
}

function validateCliPath(cliPath: string): string | null {
  if (!SAFE_CLI_PATH.test(cliPath)) {
    return `Unsafe cli_path: "${cliPath}". Only alphanumeric, -, _, ., /, \\, : allowed.`;
  }
  return null;
}

// DB에서 제네릭 프로바이더 설정 로드
async function loadGenericProviderFromDb(
  name: string,
): Promise<GenericCliProviderConfig | null> {
  const db = getDatabase();
  const key = `${GENERIC_PROVIDER_PREFIX}${name}`;
  const rows = await db
    .select()
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);

  if (rows.length === 0) return null;
  try {
    return JSON.parse(rows[0].value) as GenericCliProviderConfig;
  } catch {
    return null;
  }
}

// DB에 제네릭 프로바이더 설정 저장 (upsert)
async function saveGenericProviderToDb(
  name: string,
  config: GenericCliProviderConfig,
): Promise<void> {
  const db = getDatabase();
  const key = `${GENERIC_PROVIDER_PREFIX}${name}`;
  const now = new Date().toISOString();
  const value = JSON.stringify(config);

  const existing = await db
    .select()
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(settings).values({ key, value, updatedAt: now });
  } else {
    await db
      .update(settings)
      .set({ value, updatedAt: now })
      .where(eq(settings.key, key));
  }
}

interface GenericProviderDeps {
  registry: ProviderRegistry;
  healthChecker: HealthChecker;
  queueManager: QueueManager;
}

export function registerGenericProviderRoutes(
  app: FastifyInstance,
  deps: GenericProviderDeps,
): void {
  // 전체 제네릭 프로바이더 목록 조회
  app.get('/admin/generic-providers', async (_request, reply) => {
    const db = getDatabase();
    const rows = await db
      .select()
      .from(settings)
      .where(like(settings.key, `${GENERIC_PROVIDER_PREFIX}%`));

    const providers = rows.map((row) => {
      const name = row.key.replace(GENERIC_PROVIDER_PREFIX, '');
      try {
        const config = JSON.parse(row.value) as GenericCliProviderConfig;
        return { name, config };
      } catch {
        return null;
      }
    }).filter(Boolean);

    return reply.send(providers);
  });

  // 특정 제네릭 프로바이더 설정 조회
  app.get<{ Params: { name: string } }>(
    '/admin/generic-providers/:name',
    async (request, reply) => {
      const { name } = request.params;
      const config = await loadGenericProviderFromDb(name);

      if (!config) {
        return reply.status(404).send({
          error: { message: `Generic provider "${name}" not found.` },
        });
      }

      return reply.send({ name, config });
    },
  );

  // 제네릭 프로바이더 생성
  app.post<{ Body: { name: string } & GenericCliProviderConfig }>(
    '/admin/generic-providers',
    async (request, reply) => {
      const { name, ...configData } = request.body;

      // 이름 유효성 검사
      if (!name) {
        return reply.status(400).send({ error: { message: 'Provider name is required.' } });
      }
      const nameError = validateProviderName(name);
      if (nameError) {
        return reply.status(400).send({ error: { message: nameError } });
      }

      // 빌트인 프로바이더 이름 충돌 확인
      if (BUILTIN_PROVIDER_NAMES.includes(name)) {
        return reply.status(409).send({
          error: { message: `Cannot use built-in provider name: "${name}".` },
        });
      }

      // 이미 등록된 프로바이더 이름 확인
      if (deps.registry.has(name)) {
        return reply.status(409).send({
          error: { message: `Provider "${name}" is already registered.` },
        });
      }

      // cli_path 유효성 검사
      if (!configData.cli_path) {
        return reply.status(400).send({ error: { message: 'cli_path is required.' } });
      }
      const cliPathError = validateCliPath(configData.cli_path);
      if (cliPathError) {
        return reply.status(400).send({ error: { message: cliPathError } });
      }

      // 필수 필드 기본값 처리
      const config: GenericCliProviderConfig = {
        enabled: configData.enabled ?? true,
        cli_path: configData.cli_path,
        default_model: configData.default_model ?? '',
        max_concurrent: configData.max_concurrent ?? 2,
        timeout_ms: configData.timeout_ms ?? 120000,
        extra_args: configData.extra_args ?? [],
        prompt_mode: configData.prompt_mode ?? 'stdin',
        args_template: configData.args_template ?? [],
        output_mode: configData.output_mode ?? 'plain_text',
        streaming_enabled: configData.streaming_enabled ?? false,
        display_name: configData.display_name ?? name,
        ...(configData.prompt_arg_template !== undefined && { prompt_arg_template: configData.prompt_arg_template }),
        ...(configData.output_json_content_field !== undefined && { output_json_content_field: configData.output_json_content_field }),
        ...(configData.stream_args_template !== undefined && { stream_args_template: configData.stream_args_template }),
        ...(configData.stream_content_field !== undefined && { stream_content_field: configData.stream_content_field }),
        ...(configData.stream_done_indicator !== undefined && { stream_done_indicator: configData.stream_done_indicator }),
        ...(configData.health_check_args !== undefined && { health_check_args: configData.health_check_args }),
        ...(configData.description !== undefined && { description: configData.description }),
        ...(configData.working_dir !== undefined && { working_dir: configData.working_dir }),
      };

      // DB에 저장
      await saveGenericProviderToDb(name, config);

      // 런타임 등록
      const provider = new GenericCliProvider(name, config);
      deps.registry.register(provider);
      deps.queueManager.addQueue(name, config.max_concurrent);

      // 비동기 헬스 체크 트리거 (응답 지연 방지)
      deps.healthChecker.checkProvider(name).catch(() => {});

      return reply.status(201).send({ name, config });
    },
  );

  // 제네릭 프로바이더 설정 수정
  app.put<{ Params: { name: string }; Body: Partial<GenericCliProviderConfig> }>(
    '/admin/generic-providers/:name',
    async (request, reply) => {
      const { name } = request.params;
      const partial = request.body;

      // 기존 설정 로드
      const existing = await loadGenericProviderFromDb(name);
      if (!existing) {
        return reply.status(404).send({
          error: { message: `Generic provider "${name}" not found.` },
        });
      }

      // cli_path 변경 시 유효성 검사
      if (partial.cli_path !== undefined) {
        const cliPathError = validateCliPath(partial.cli_path);
        if (cliPathError) {
          return reply.status(400).send({ error: { message: cliPathError } });
        }
      }

      // 기존 설정과 병합
      const updated: GenericCliProviderConfig = { ...existing, ...partial };

      // DB 업데이트
      await saveGenericProviderToDb(name, updated);

      // 구조적 변경 여부 판단 (재등록 필요 여부)
      const structuralFields: Array<keyof GenericCliProviderConfig> = [
        'args_template',
        'prompt_mode',
        'prompt_arg_template',
        'output_mode',
        'output_json_content_field',
        'streaming_enabled',
        'stream_args_template',
        'stream_content_field',
        'stream_done_indicator',
        'health_check_args',
        'cli_path',
      ];
      const hasStructuralChange = structuralFields.some(
        (field) => partial[field] !== undefined,
      );

      if (hasStructuralChange && deps.registry.has(name)) {
        // 기존 프로바이더 제거 후 새 인스턴스 등록
        deps.registry.unregister(name);
        const newProvider = new GenericCliProvider(name, updated);
        deps.registry.register(newProvider);
      } else if (deps.registry.has(name)) {
        // 기본 필드만 런타임 업데이트
        deps.registry.updateProviderConfig(name, partial);
      }

      // max_concurrent 변경 시 큐 동시 처리 수 갱신
      if (partial.max_concurrent !== undefined) {
        deps.queueManager.updateConcurrency(name, partial.max_concurrent);
      }

      return reply.send({ name, config: updated });
    },
  );

  // 제네릭 프로바이더 삭제
  app.delete<{ Params: { name: string } }>(
    '/admin/generic-providers/:name',
    async (request, reply) => {
      const { name } = request.params;

      // 빌트인 프로바이더 삭제 차단
      if (BUILTIN_PROVIDER_NAMES.includes(name)) {
        return reply.status(403).send({
          error: { message: `Cannot delete built-in provider: "${name}".` },
        });
      }

      // DB에 존재하는지 확인
      const existing = await loadGenericProviderFromDb(name);
      if (!existing) {
        return reply.status(404).send({
          error: { message: `Generic provider "${name}" not found.` },
        });
      }

      const db = getDatabase();

      // DB에서 제거 (generic_provider:{name} 키)
      await db
        .delete(settings)
        .where(eq(settings.key, `${GENERIC_PROVIDER_PREFIX}${name}`));

      // DB에서 제거 (provider_config:{name} 오버라이드 키)
      await db
        .delete(settings)
        .where(eq(settings.key, `${PROVIDER_CONFIG_PREFIX}${name}`));

      // providerHealth 테이블 정리
      await db
        .delete(providerHealth)
        .where(eq(providerHealth.provider, name));

      // 런타임에서 제거
      if (deps.registry.has(name)) {
        deps.registry.unregister(name);
      }
      deps.queueManager.removeQueue(name);

      return reply.send({ success: true });
    },
  );

  // 등록 전 테스트 — 임시 GenericCliProvider 인스턴스를 생성하여 실행
  app.post<{ Body: { name?: string } & GenericCliProviderConfig }>(
    '/admin/generic-providers/test',
    async (request, reply) => {
      const { name, ...configData } = request.body;
      const providerName = name || '__test__';

      if (!configData.cli_path) {
        return reply.status(400).send({ error: { message: 'cli_path is required.' } });
      }
      const cliPathError = validateCliPath(configData.cli_path);
      if (cliPathError) {
        return reply.status(400).send({ error: { message: cliPathError } });
      }

      const config: GenericCliProviderConfig = {
        enabled: true,
        cli_path: configData.cli_path,
        default_model: configData.default_model ?? '',
        max_concurrent: configData.max_concurrent ?? 10,
        timeout_ms: configData.timeout_ms ?? 300000,
        extra_args: configData.extra_args ?? [],
        prompt_mode: configData.prompt_mode ?? 'stdin',
        args_template: configData.args_template ?? [],
        output_mode: configData.output_mode ?? 'plain_text',
        streaming_enabled: configData.streaming_enabled ?? false,
        display_name: configData.display_name ?? providerName,
        ...(configData.prompt_arg_template !== undefined && { prompt_arg_template: configData.prompt_arg_template }),
        ...(configData.output_json_content_field !== undefined && { output_json_content_field: configData.output_json_content_field }),
        ...(configData.stream_args_template !== undefined && { stream_args_template: configData.stream_args_template }),
        ...(configData.stream_content_field !== undefined && { stream_content_field: configData.stream_content_field }),
        ...(configData.stream_done_indicator !== undefined && { stream_done_indicator: configData.stream_done_indicator }),
        ...(configData.health_check_args !== undefined && { health_check_args: configData.health_check_args }),
        ...(configData.working_dir !== undefined && { working_dir: configData.working_dir }),
      };

      // 임시 프로바이더 인스턴스로 테스트
      const testProvider = new GenericCliProvider(providerName, config);
      const model = config.default_model || '';
      const startTime = Date.now();

      try {
        const result = await testProvider.execute({
          messages: [{ role: 'user', content: 'Say "OK" and nothing else.' }],
          model,
          stream: false,
        });
        const latencyMs = Date.now() - startTime;

        return reply.send({
          success: true,
          response: result.content.substring(0, 200),
          latencyMs,
          usage: result.usage,
        });
      } catch (err) {
        const latencyMs = Date.now() - startTime;
        return reply.send({
          success: false,
          error: err instanceof Error ? err.message : String(err),
          latencyMs,
        });
      }
    },
  );
}
