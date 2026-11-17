import { useCallback, useEffect, useState } from 'react';

import { listModels, type LocalModel } from '../services/model-pack';

/**
 * Screens read the installed models through this hook, so a download or a
 * removal has to reach every mounted screen. The model manager publishes here
 * after it writes to the model directory; without it the assistant keeps a
 * stale answer (for example, no "Say it in plain words" action right after
 * Woof finished downloading).
 */
type ModelListener = () => void;

const listeners = new Set<ModelListener>();

export function notifyModelsChanged(): void {
  for (const listener of listeners) listener();
}

/** Prefer the named model for each role; fall back to any compatible file. */
function pick(models: LocalModel[], kind: LocalModel['kind'], needle: string): LocalModel | null {
  return (
    models.find((model) => model.name.toLowerCase().includes(needle)) ??
    models.find((model) => model.kind === kind) ??
    null
  );
}

export type ModelState = {
  text: LocalModel | null;
  voice: LocalModel | null;
  vision: LocalModel | null;
  all: LocalModel[];
  loading: boolean;
};

const EMPTY: ModelState = { text: null, voice: null, vision: null, all: [], loading: true };

/** Scan the app's model directory. Importing a file calls `refresh`. */
export function useModels() {
  const [state, setState] = useState<ModelState>(EMPTY);

  const refresh = useCallback(async () => {
    const all = await listModels();
    setState({
      text: pick(all, 'text', 'bonsai') ?? pick(all, 'text', 'woof'),
      voice: pick(all, 'voice', 'shruti'),
      vision: pick(all, 'vision', 'mirage'),
      all,
      loading: false,
    });
  }, []);

  useEffect(() => {
    const listener: ModelListener = () => void refresh();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const all = await listModels();
      if (cancelled) return;
      setState({
        text: pick(all, 'text', 'bonsai') ?? pick(all, 'text', 'woof'),
        voice: pick(all, 'voice', 'shruti'),
        vision: pick(all, 'vision', 'mirage'),
        all,
        loading: false,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { ...state, refresh };
}

export type ModelsApi = ReturnType<typeof useModels>;
