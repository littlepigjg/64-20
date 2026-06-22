import { Router, Request, Response } from 'express';
import { config } from '../../config';
import { getMetadataIndex } from '../metadata';
import { getCacheStorage } from '../cache';
import { makeRequest, normalizePypiName, pypiNamesMatch, parsePypiPackageLinks } from '../proxy/utils';
import { parseNpmPackageName, sanitizePath } from '../../utils';
import type { RegistryType, PreheatTask, PreheatPackageInput, PreheatPackageResult } from '../../types';

const tasks = new Map<string, PreheatTask>();
const cancellations = new Map<string, boolean>();

function generateId(): string {
  return `ph_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createTask(packages: PreheatPackageInput[]): PreheatTask {
  return {
    id: generateId(),
    status: 'pending',
    packages,
    total: packages.length,
    completed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    results: [],
    startedAt: null,
    completedAt: null,
    estimatedEnd: null,
    createdAt: Date.now(),
  };
}

async function preheatNpmPackage(
  input: PreheatPackageInput,
  task: PreheatTask
): Promise<PreheatPackageResult> {
  const start = Date.now();
  const cache = getCacheStorage();
  const metadata = getMetadataIndex();
  const { scope } = parseNpmPackageName(input.name);

  try {
    const response = await makeRequest(
      `${config.npm.upstream}/${encodeURIComponent(input.name)}`,
      { timeout: 30000 }
    );

    if (response.statusCode !== 200) {
      return {
        name: input.name,
        registry: 'npm',
        version: input.version || '',
        status: 'failed',
        size: 0,
        error: `Upstream returned ${response.statusCode}`,
        duration: Date.now() - start,
      };
    }

    if (cancellations.get(task.id)) {
      return {
        name: input.name,
        registry: 'npm',
        version: input.version || '',
        status: 'skipped',
        size: 0,
        duration: Date.now() - start,
      };
    }

    const pkgData = JSON.parse(response.body.toString());
    const versionEntries = Object.entries(pkgData.versions || {});
    const targetVersions = input.version
      ? versionEntries.filter(([v]) => v === input.version)
      : versionEntries;

    if (targetVersions.length === 0) {
      return {
        name: input.name,
        registry: 'npm',
        version: input.version || 'latest',
        status: 'failed',
        size: 0,
        error: input.version ? `Version ${input.version} not found` : 'No versions found',
        duration: Date.now() - start,
      };
    }

    let totalSize = 0;
    const pkgId = metadata.getOrCreatePackage(input.name, 'npm', 'cache', scope);
    metadata.upsertPackageInfo({
      name: input.name,
      registry: 'npm',
      description: pkgData.description,
      author: typeof pkgData.author === 'string' ? pkgData.author : pkgData.author?.name,
      license: typeof pkgData.license === 'string' ? pkgData.license : pkgData.license?.type,
      latestVersion: pkgData['dist-tags']?.latest || '',
      source: 'cache',
      scope,
    });

    for (const [version, verData] of targetVersions) {
      if (cancellations.get(task.id)) {
        return {
          name: input.name,
          registry: 'npm',
          version,
          status: 'skipped',
          size: totalSize,
          duration: Date.now() - start,
        };
      }

      const dist = (verData as any).dist || {};
      const tarballUrl: string = dist.tarball || '';
      const filename = tarballUrl.split('/').pop() || `${sanitizePath(input.name)}-${version}.tgz`;
      const cachePath = cache.getNpmCachePath(input.name, version, filename);

      if (cache.fileExists(cachePath)) {
        metadata.addVersion(pkgId, version, cache.getFileSize(cachePath), cachePath, dist.shasum);
        totalSize += cache.getFileSize(cachePath);
        continue;
      }

      const tarResponse = await makeRequest(tarballUrl, { timeout: 60000 });
      if (tarResponse.statusCode !== 200) continue;

      cache.writeFile(cachePath, tarResponse.body);
      metadata.addVersion(pkgId, version, tarResponse.body.length, cachePath, dist.shasum);
      totalSize += tarResponse.body.length;
    }

    return {
      name: input.name,
      registry: 'npm',
      version: input.version || 'all',
      status: 'success',
      size: totalSize,
      duration: Date.now() - start,
    };
  } catch (err: any) {
    return {
      name: input.name,
      registry: 'npm',
      version: input.version || '',
      status: 'failed',
      size: 0,
      error: err.message || 'Unknown error',
      duration: Date.now() - start,
    };
  }
}

async function preheatPypiPackage(
  input: PreheatPackageInput,
  task: PreheatTask
): Promise<PreheatPackageResult> {
  const start = Date.now();
  const cache = getCacheStorage();
  const metadata = getMetadataIndex();

  try {
    const normalizedName = normalizePypiName(input.name);
    const firstLetter = normalizedName[0]?.toLowerCase() || normalizedName[0];

    const simpleResponse = await makeRequest(
      `${config.pypi.simpleUpstream}/${encodeURIComponent(input.name)}/`,
      { timeout: 15000 }
    );

    if (simpleResponse.statusCode !== 200) {
      return {
        name: input.name,
        registry: 'pypi',
        version: input.version || '',
        status: 'failed',
        size: 0,
        error: `Upstream returned ${simpleResponse.statusCode}`,
        duration: Date.now() - start,
      };
    }

    if (cancellations.get(task.id)) {
      return {
        name: input.name,
        registry: 'pypi',
        version: input.version || '',
        status: 'skipped',
        size: 0,
        duration: Date.now() - start,
      };
    }

    const upstreamFiles = parsePypiPackageLinks(simpleResponse.body.toString('utf-8'));
    let targetFiles = upstreamFiles;

    if (input.version) {
      targetFiles = upstreamFiles.filter((f) =>
        f.filename.includes(input.version!.replace(/\.0+$/, ''))
      );
      if (targetFiles.length === 0) {
        targetFiles = upstreamFiles.filter((f) => f.filename.includes(input.version!));
      }
    }

    if (targetFiles.length === 0) {
      return {
        name: input.name,
        registry: 'pypi',
        version: input.version || 'latest',
        status: 'failed',
        size: 0,
        error: input.version ? `Version ${input.version} files not found` : 'No files found',
        duration: Date.now() - start,
      };
    }

    let totalSize = 0;
    const pkgId = metadata.getOrCreatePackage(input.name, 'pypi', 'cache');

    for (const file of targetFiles) {
      if (cancellations.get(task.id)) {
        return {
          name: input.name,
          registry: 'pypi',
          version: input.version || file.filename,
          status: 'skipped',
          size: totalSize,
          duration: Date.now() - start,
        };
      }

      const versionMatch = file.filename.match(/(\d+\.\d+(?:\.\d+)?(?:[a-zA-Z0-9._-]*)?)/);
      const version = versionMatch ? versionMatch[1] : '0.0.0';
      const cachePath = cache.getPypiCachePath(input.name, version, file.filename);

      if (cache.fileExists(cachePath)) {
        metadata.addVersion(pkgId, version, cache.getFileSize(cachePath), cachePath);
        totalSize += cache.getFileSize(cachePath);
        continue;
      }

      const normalizedName2 = input.name.replace(/_/g, '-');
      const fl = normalizedName2[0]?.toLowerCase() || normalizedName2[0];
      const upstreamUrl = `https://files.pythonhosted.org/packages/source/${fl}/${normalizedName2}/${file.filename}`;

      const fileResponse = await makeRequest(upstreamUrl, { timeout: 60000 });
      if (fileResponse.statusCode !== 200) continue;

      cache.writeFile(cachePath, fileResponse.body);
      metadata.addVersion(pkgId, version, fileResponse.body.length, cachePath);
      totalSize += fileResponse.body.length;
    }

    return {
      name: input.name,
      registry: 'pypi',
      version: input.version || 'all',
      status: 'success',
      size: totalSize,
      duration: Date.now() - start,
    };
  } catch (err: any) {
    return {
      name: input.name,
      registry: 'pypi',
      version: input.version || '',
      status: 'failed',
      size: 0,
      error: err.message || 'Unknown error',
      duration: Date.now() - start,
    };
  }
}

async function runPreheatTask(task: PreheatTask): Promise<void> {
  task.status = 'running';
  task.startedAt = Date.now();

  for (let i = 0; i < task.packages.length; i++) {
    if (cancellations.get(task.id)) {
      task.status = 'cancelled';
      task.completedAt = Date.now();
      return;
    }

    const input = task.packages[i];
    let result: PreheatPackageResult;

    if (input.registry === 'npm') {
      result = await preheatNpmPackage(input, task);
    } else {
      result = await preheatPypiPackage(input, task);
    }

    if (cancellations.get(task.id) && result.status !== 'skipped') {
      result.status = 'skipped';
    }

    task.results.push(result);
    task.completed++;

    if (result.status === 'success') task.succeeded++;
    else if (result.status === 'failed') task.failed++;
    else task.skipped++;

    if (task.completed < task.total) {
      const elapsed = Date.now() - task.startedAt!;
      const avgPerPkg = elapsed / task.completed;
      const remaining = task.total - task.completed;
      task.estimatedEnd = Date.now() + avgPerPkg * remaining;
    } else {
      task.estimatedEnd = null;
    }
  }

  task.status = 'completed';
  task.completedAt = Date.now();
  task.estimatedEnd = null;
  cancellations.delete(task.id);
}

const preheatRouter = Router();

preheatRouter.post('/', (req: Request, res: Response) => {
  const body = req.body || {};
  const packages: PreheatPackageInput[] = Array.isArray(body.packages) ? body.packages : [];

  if (packages.length === 0) {
    res.status(400).json({ error: 'No packages provided' });
    return;
  }

  for (const pkg of packages) {
    if (!pkg.name || !pkg.registry) {
      res.status(400).json({ error: 'Each package must have name and registry' });
      return;
    }
    if (pkg.registry !== 'npm' && pkg.registry !== 'pypi') {
      res.status(400).json({ error: `Invalid registry: ${pkg.registry}` });
      return;
    }
  }

  const task = createTask(packages);
  tasks.set(task.id, task);
  cancellations.set(task.id, false);

  runPreheatTask(task).catch((err) => {
    console.error(`Preheat task ${task.id} error:`, err);
    task.status = 'completed';
    task.completedAt = Date.now();
  });

  res.json({ taskId: task.id, total: task.total });
});

preheatRouter.get('/:taskId', (req: Request, res: Response) => {
  const task = tasks.get(req.params.taskId as string);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  res.json(task);
});

preheatRouter.post('/:taskId/cancel', (req: Request, res: Response) => {
  const task = tasks.get(req.params.taskId as string);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  if (task.status !== 'running' && task.status !== 'pending') {
    res.status(400).json({ error: 'Task is not running' });
    return;
  }
  cancellations.set(task.id, true);
  res.json({ success: true, taskId: task.id });
});

export { preheatRouter };
