import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Flame,
  Play,
  XCircle,
  Loader2,
  CheckCircle2,
  XCircle as FailIcon,
  MinusCircle,
  Clock,
  Package as PackageIcon,
} from 'lucide-react';
import { api } from '../api';
import type { PreheatTask, PreheatPackageInput, PreheatPackageResult } from '../types';
import { formatSize } from '../utils';

type Phase = 'input' | 'running' | 'done';

export default function Preheat() {
  const [phase, setPhase] = useState<Phase>('input');
  const [text, setText] = useState('');
  const [taskId, setTaskId] = useState<string | null>(null);
  const [task, setTask] = useState<PreheatTask | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(
    (id: string) => {
      stopPolling();
      pollRef.current = setInterval(async () => {
        try {
          const t = await api.getPreheatTask(id);
          setTask(t);
          if (t.status === 'completed' || t.status === 'cancelled') {
            stopPolling();
            setPhase('done');
          }
        } catch {
          stopPolling();
        }
      }, 1000);
    },
    [stopPolling]
  );

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  const parseInput = (): PreheatPackageInput[] | null => {
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const packages: PreheatPackageInput[] = [];
    for (const line of lines) {
      const trimmed = line.replace(/,|\t/g, ' ').replace(/\s+/g, ' ').trim();
      if (!trimmed) continue;

      const parts = trimmed.split(' ');
      let registry: 'npm' | 'pypi' | undefined;
      let name: string | undefined;
      let version: string | undefined;

      if (parts[0] === 'npm' || parts[0] === 'pypi') {
        registry = parts[0] as 'npm' | 'pypi';
        name = parts[1];
        version = parts[2];
      } else {
        name = parts[0];
        version = parts[1];
      }

      if (!name) continue;

      const atIndex = name.indexOf('@');
      if (atIndex > 0) {
        version = name.slice(atIndex + 1);
        name = name.slice(0, atIndex);
      }

      if (!registry) {
        registry = name.startsWith('@') || !name.includes('-') || name.includes('/') ? 'npm' : 'npm';
      }

      packages.push({ name, registry, version: version || undefined });
    }

    if (packages.length === 0) {
      setError('请输入至少一个包名');
      return null;
    }

    return packages;
  };

  const handleStart = async () => {
    setError(null);
    const packages = parseInput();
    if (!packages) return;

    try {
      const result = await api.startPreheat(packages);
      setTaskId(result.taskId);
      setPhase('running');
      startPolling(result.taskId);
    } catch (err: any) {
      setError(err.message || '启动预热任务失败');
    }
  };

  const handleCancel = async () => {
    if (!taskId) return;
    setCancelling(true);
    try {
      await api.cancelPreheat(taskId);
    } catch {
    } finally {
      setCancelling(false);
    }
  };

  const handleReset = () => {
    setPhase('input');
    setTaskId(null);
    setTask(null);
    setError(null);
    setCancelling(false);
    setText('');
  };

  const progress = task ? Math.round((task.completed / task.total) * 100) : 0;

  const estimatedTimeLeft = useCallback((): string => {
    if (!task || !task.startedAt || task.completed === 0) return '计算中...';
    const elapsed = Date.now() - task.startedAt;
    const avg = elapsed / task.completed;
    const remaining = (task.total - task.completed) * avg;
    if (remaining < 1000) return '即将完成';
    if (remaining < 60000) return `约 ${Math.ceil(remaining / 1000)} 秒`;
    if (remaining < 3600000) return `约 ${Math.ceil(remaining / 60000)} 分钟`;
    return `约 ${(remaining / 3600000).toFixed(1)} 小时`;
  }, [task]);

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
          <Flame size={28} className="text-orange-500" /> 缓存预热
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          在部署新版本之前主动触发包缓存，确保应用启动时可以立即从本地获取依赖
        </p>
      </div>

      {phase === 'input' && (
        <div className="card p-6">
          <h2 className="text-lg font-semibold text-slate-800 mb-4">包列表输入</h2>
          <p className="text-sm text-slate-500 mb-3">
            每行一个包，支持以下格式：
          </p>
          <div className="text-xs text-slate-500 bg-slate-50 p-3 rounded-lg mb-4 space-y-1 font-mono">
            <div>npm express</div>
            <div>npm express 4.18.2</div>
            <div>pypi requests</div>
            <div>pypi flask 2.3.0</div>
            <div>express@4.18.2</div>
          </div>
          <textarea
            className="input font-mono text-sm"
            rows={10}
            placeholder={`npm express\nnpm lodash 4.17.21\npypi requests\npypi flask 2.3.0`}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex items-center gap-3 mt-4">
            <button className="btn btn-primary" onClick={handleStart}>
              <Play size={16} /> 开始预热
            </button>
            {error && (
              <span className="text-sm text-red-600">{error}</span>
            )}
          </div>
        </div>
      )}

      {(phase === 'running' || phase === 'done') && task && (
        <>
          <div className="card p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-slate-800">
                {phase === 'running' ? '预热进行中' : task.status === 'cancelled' ? '已取消' : '预热完成'}
              </h2>
              {phase === 'running' && (
                <div className="flex items-center gap-2">
                  {task.status === 'running' && (
                    <span className="text-sm text-slate-500 flex items-center gap-1">
                      <Clock size={14} /> 剩余 {estimatedTimeLeft()}
                    </span>
                  )}
                  <button
                    className="btn btn-danger text-sm"
                    onClick={handleCancel}
                    disabled={cancelling || task.status !== 'running'}
                  >
                    <XCircle size={16} />
                    {cancelling ? '取消中...' : '取消任务'}
                  </button>
                </div>
              )}
            </div>

            <div className="mb-4">
              <div className="flex justify-between text-sm mb-2">
                <span className="text-slate-600">
                  {task.completed} / {task.total} 包
                </span>
                <span className="font-semibold text-slate-800">{progress}%</span>
              </div>
              <div className="progress-bar h-4">
                <div
                  className={`progress-fill ${
                    task.status === 'cancelled'
                      ? 'bg-yellow-500'
                      : progress === 100
                      ? 'bg-emerald-500'
                      : 'bg-gradient-to-r from-indigo-500 to-purple-500'
                  }`}
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <StatBox
                label="成功"
                value={task.succeeded}
                color="text-emerald-600"
                bg="bg-emerald-50"
                icon={<CheckCircle2 size={18} className="text-emerald-500" />}
              />
              <StatBox
                label="失败"
                value={task.failed}
                color="text-red-600"
                bg="bg-red-50"
                icon={<FailIcon size={18} className="text-red-500" />}
              />
              <StatBox
                label="跳过"
                value={task.skipped}
                color="text-yellow-600"
                bg="bg-yellow-50"
                icon={<MinusCircle size={18} className="text-yellow-500" />}
              />
            </div>
          </div>

          {task.results.length > 0 && (
            <div className="card p-6">
              <h2 className="text-lg font-semibold text-slate-800 mb-4 flex items-center gap-2">
                <PackageIcon size={20} /> 执行详情
              </h2>
              <div className="overflow-x-auto">
                <table>
                  <thead>
                    <tr>
                      <th>状态</th>
                      <th>仓库</th>
                      <th>包名</th>
                      <th>版本</th>
                      <th>大小</th>
                      <th>耗时</th>
                      <th>错误信息</th>
                    </tr>
                  </thead>
                  <tbody>
                    {task.results.map((r, i) => (
                      <ResultRow key={i} result={r} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {phase === 'done' && (
            <div className="flex items-center gap-3">
              <button className="btn btn-primary" onClick={handleReset}>
                新建预热任务
              </button>
              {task.succeeded > 0 && (
                <span className="text-sm text-emerald-600 flex items-center gap-1">
                  <CheckCircle2 size={16} />
                  成功缓存 {task.succeeded} 个包，共{' '}
                  {formatSize(task.results.filter((r) => r.status === 'success').reduce((s, r) => s + r.size, 0))}
                </span>
              )}
              {task.failed > 0 && (
                <span className="text-sm text-red-600 flex items-center gap-1">
                  <FailIcon size={16} />
                  {task.failed} 个包预热失败
                </span>
              )}
            </div>
          )}
        </>
      )}

      {phase === 'running' && (
        <div className="card p-6">
          <h2 className="text-lg font-semibold text-slate-800 mb-4">使用说明</h2>
          <div className="text-sm text-slate-600 space-y-2">
            <p>
              预热任务在后台异步执行，不会阻塞您进行其他操作。您可以随时取消任务，已缓存的包不会被回滚。
            </p>
            <p>
              关闭此页面不会影响预热任务，您可以稍后回来查看结果。
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function StatBox({
  label,
  value,
  color,
  bg,
  icon,
}: {
  label: string;
  value: number;
  color: string;
  bg: string;
  icon: React.ReactNode;
}) {
  return (
    <div className={`p-4 rounded-lg ${bg} flex items-center gap-3`}>
      {icon}
      <div>
        <div className={`text-2xl font-bold ${color}`}>{value}</div>
        <div className="text-xs text-slate-500">{label}</div>
      </div>
    </div>
  );
}

function ResultRow({ result }: { result: PreheatPackageResult }) {
  const statusIcon =
    result.status === 'success' ? (
      <CheckCircle2 size={16} className="text-emerald-500" />
    ) : result.status === 'failed' ? (
      <FailIcon size={16} className="text-red-500" />
    ) : (
      <MinusCircle size={16} className="text-yellow-500" />
    );

  const statusText =
    result.status === 'success'
      ? '成功'
      : result.status === 'failed'
      ? '失败'
      : '跳过';

  return (
    <tr>
      <td>
        <div className="flex items-center gap-1.5">
          {statusIcon}
          <span className="text-sm">{statusText}</span>
        </div>
      </td>
      <td>
        <span
          className={`badge ${
            result.registry === 'npm'
              ? 'bg-orange-100 text-orange-700'
              : 'bg-sky-100 text-sky-700'
          }`}
        >
          {result.registry.toUpperCase()}
        </span>
      </td>
      <td className="font-mono text-sm">{result.name}</td>
      <td className="font-mono text-sm text-slate-500">{result.version}</td>
      <td className="text-sm">{result.size > 0 ? formatSize(result.size) : '-'}</td>
      <td className="text-sm text-slate-500">
        {result.duration < 1000
          ? `${result.duration}ms`
          : `${(result.duration / 1000).toFixed(1)}s`}
      </td>
      <td className="text-sm text-red-500 max-w-xs truncate">
        {result.error || '-'}
      </td>
    </tr>
  );
}
