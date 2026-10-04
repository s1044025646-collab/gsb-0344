// CLI：create/list/read/insert/delete/undo/redo/pieces/locate/history/export/serve/demo
import path from 'node:path';
import { DocStore, LIMITS } from './store.js';
import { PtError } from './core.js';
import { startServer } from './server.js';
import { runDemo } from './demo.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DEFAULT_DB = path.join(DATA_DIR, 'piecetable.db');

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function dbPath(args: string[]): string {
  return path.resolve(argValue(args, 'db') ?? DEFAULT_DB);
}

function show(x: unknown): void {
  console.log(JSON.stringify(x, null, 2));
}

export async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const store = new DocStore(dbPath(rest));
  try {
    switch (cmd) {
      case 'create': {
        const name = argValue(rest, 'name') ?? '未命名';
        const text = argValue(rest, 'text') ?? '';
        show(store.create(name, text));
        break;
      }
      case 'list':
        show(store.list());
        break;
      case 'read': {
        const id = Number(rest[0]);
        const { pt, version } = store.open(id);
        const start = argValue(rest, 'start');
        const len = argValue(rest, 'len');
        show({ version, text: pt.slice(start ? Number(start) : 0, len ? Number(len) : undefined) });
        break;
      }
      case 'insert':
        show(store.insert(Number(rest[0]), Number(argValue(rest, 'pos')), argValue(rest, 'text') ?? '', optVer(rest)));
        break;
      case 'delete':
        show(store.delete(Number(rest[0]), Number(argValue(rest, 'pos')), Number(argValue(rest, 'len')), optVer(rest)));
        break;
      case 'undo':
        show(store.undo(Number(rest[0])));
        break;
      case 'redo':
        show(store.redo(Number(rest[0])));
        break;
      case 'pieces': {
        const { pt, version } = store.open(Number(rest[0]));
        let d = 0;
        console.log(`版本 ${version}，长度 ${pt.length} 码点`);
        console.log('idx\tsource\tstart\tlen\tdisplay');
        pt.pieces.forEach((p, i) => {
          console.log(`${i}\t${p.source}\t${p.start}\t${p.length}\t[${d}, ${d + p.length})`);
          d += p.length;
        });
        break;
      }
      case 'locate':
        show(store.open(Number(rest[0])).pt.locate(Number(argValue(rest, 'pos'))));
        break;
      case 'history':
        show(store.history(Number(rest[0])));
        break;
      case 'export': {
        const { pt, version } = store.open(Number(rest[0]));
        console.log(JSON.stringify({ version, text: pt.text() }));
        break;
      }
      case 'limits':
        show(LIMITS);
        break;
      case 'serve': {
        const port = argValue(rest, 'port') ? Number(argValue(rest, 'port')) : undefined;
        const { port: actual } = await startServer(dbPath(rest), port);
        console.log(`API 服务已启动: http://127.0.0.1:${actual}`);
        return; // 保持进程
      }
      case 'demo':
        await runDemo(store);
        break;
      default:
        console.log(`用法: node dist/src/cli.js <命令> [参数] [--db 路径]
命令:
  create --name N --text T        创建文档
  list                            列出文档
  read <id> [--start S] [--len L] 读取区间（码点）
  insert <id> --pos P --text T [--version V]
  delete <id> --pos P --len L [--version V]
  undo <id> / redo <id>
  pieces <id>                     查看片段表
  locate <id> --pos P             查询显示位置的来源
  history <id>                    查看历史
  export <id>                     导出全文
  serve [--port N]                启动 API（默认空闲端口）
  demo                            运行演示
  limits                          查看大小限制`);
    }
  } finally {
    if (cmd !== 'serve') store.close();
  }
}

function optVer(rest: string[]): number | undefined {
  const v = argValue(rest, 'version');
  return v === undefined ? undefined : Number(v);
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
  main(process.argv.slice(2)).catch((e) => {
    if (e instanceof PtError) {
      console.error(`错误 [${e.code}] ${e.message}`);
      process.exit(2);
    }
    console.error(e);
    process.exit(1);
  });
}
