/**
 * Save files received over the mesh.
 *
 * Map packs go into the same directory the map screen already reads, so a
 * received `.mbtiles` file becomes usable immediately. Everything else goes to
 * a `received-files` folder. Names are sanitised and collisions get a suffix.
 */

import { Directory, File, Paths } from 'expo-file-system';

import type { ReceivedFile } from '../core/mesh/engine';

function safeName(name: string): string {
  const base = name.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '').trim();
  return (base.length > 0 ? base : 'received-file').slice(0, 120);
}

function ensureDirectory(name: string): Directory {
  const directory = new Directory(Paths.document, name);
  if (!directory.exists) directory.create({ intermediates: true, idempotent: true });
  return directory;
}

export type SavedFile = {
  name: string;
  uri: string;
  size: number;
  kind: 'map' | 'file';
  mime: string;
};

export async function saveReceivedFile(file: ReceivedFile): Promise<SavedFile | null> {
  try {
    const isMap = file.kind === 'map' || file.name.toLowerCase().endsWith('.mbtiles');
    const directory = ensureDirectory(isMap ? 'map-packs' : 'received-files');
    const clean = safeName(file.name);
    let target = new File(directory, clean);

    if (target.exists) {
      const dot = clean.lastIndexOf('.');
      const stem = dot > 0 ? clean.slice(0, dot) : clean;
      const extension = dot > 0 ? clean.slice(dot) : '';
      target = new File(directory, `${stem}-${Date.now().toString(36)}${extension}`);
    }
    target.write(file.bytes);

    return {
      name: target.name,
      uri: target.uri,
      size: file.size,
      kind: isMap ? 'map' : 'file',
      mime: file.mime,
    };
  } catch {
    return null;
  }
}
