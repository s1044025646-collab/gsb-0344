#!/usr/bin/env node
import { DocumentStore } from './store.js';

interface ParsedArgs {
  command: string;
  values: string[];
  options: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const values: string[] = [];
  const options: Record<string, string> = {};
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [key, rawValue] = arg.slice(2).split('=');
      options[key] = rawValue ?? 'true';
    } else {
      values.push(arg);
    }
  }
  return { command: values[0] ?? 'help', values: values.slice(1), options };
}

function option(args: ParsedArgs, ...keys: string[]): string | undefined {
  for (const key of keys) if (args.options[key] !== undefined) return args.options[key];
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function usage(): void {
  console.log(`用法:
  npm run cli -- create --id=demo --text="你好😀"
  npm run cli -- get demo
  npm run cli -- read demo --start=0 --end=3
  npm run cli -- insert demo --version=0 --position=2 --text="世界"
  npm run cli -- delete demo --version=1 --start=0 --end=2
  npm run cli -- undo demo --version=1
  npm run cli -- redo demo --version=0
  npm run cli -- pieces demo
  npm run cli -- source demo --position=2
  npm run cli -- history demo
  npm run cli -- export demo`);
}

const args = parseArgs(process.argv.slice(2));
const store = new DocumentStore(process.env.PT_DB ?? 'data/piece-table.db');

try {
  const id = args.values[0];
  switch (args.command) {
    case 'create':
      print(store.createDocument(option(args, 'text') ?? '', option(args, 'id')));
      break;
    case 'get':
      print(store.get(requireId(id)));
      break;
    case 'read': {
      const snapshot = store.get(requireId(id));
      print(store.read(requireId(id), option(args, 'start') ?? 0, option(args, 'end') ?? String(snapshot.length)));
      break;
    }
    case 'insert':
      print(store.edit(requireId(id), numberOption(option(args, 'version')), {
        type: 'insert',
        position: numberOption(option(args, 'position')),
        text: option(args, 'text') ?? '',
      }));
      break;
    case 'delete':
      print(store.edit(requireId(id), numberOption(option(args, 'version')), {
        type: 'delete',
        start: numberOption(option(args, 'start')),
        end: numberOption(option(args, 'end')),
      }));
      break;
    case 'undo':
      print(store.undo(requireId(id), numberOption(option(args, 'version'))));
      break;
    case 'redo':
      print(store.redo(requireId(id), numberOption(option(args, 'version'))));
      break;
    case 'pieces':
      print(store.pieces(requireId(id)));
      break;
    case 'source':
      print(store.source(requireId(id), numberOption(option(args, 'position'))));
      break;
    case 'history':
      print(store.history(requireId(id)));
      break;
    case 'export':
      print(store.export(requireId(id)));
      break;
    default:
      usage();
  }
} catch (error) {
  if (error instanceof Error) console.error(JSON.stringify({ error: error.name, message: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  store.close();
}

function requireId(id: string | undefined): string {
  if (!id) throw new Error('缺少文档 ID');
  return id;
}

function numberOption(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) throw new Error('数值参数必须是非负整数');
  return Number(value);
}
