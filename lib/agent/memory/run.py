#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""run.py —— 插件跑记忆/学习脚本的**唯一入口**（代码在包里，数据在 stateDir）。

为什么要这一层（这是本任务最关键的设计决定）：

三个 py 文件（memctl / stylebank / lexicon）全部把落盘路径从**自己 `__file__`
所在目录**推导出来：

    BASE = os.path.dirname(os.path.abspath(__file__))
    DB   = os.path.join(BASE, "mem.db")          # memctl
    STYLE_DB = os.path.join(BASE, "style.db")    # stylebank

这在脚本版里是对的（代码和数据就在 qq-agent/memory/ 同一个目录）。但插件里
这两件事必须分开：

  ① **代码在 npm 包里**（`lib/agent/memory/`）—— 升级靠 npm，只读，绝不写；
  ② **数据在 stateDir**（`~/.dsh/llminqq/`）—— npm uninstall 不能删掉用户记忆。

如果直接把 py 文件复制到 stateDir 再跑（而不是走这个 launcher），会有两个问题：
  · 每次升级都要重拷一遍代码（漏拷就是「插件升了、记忆还是老逻辑」）；
  · 同一份逻辑在磁盘上出现两份，排查时分不清跑的是哪份。

所以：**import 包内那份代码，然后只改写它的路径常量**。这样
`BASE` 仍是包目录（代码/reflection_llm.mjs 都能找到），而所有落盘都落到 stateDir。
升级只需 npm 换包，用户数据一动不动。

⚠️ 这里的每个路径常量名都是「实现细节」：三个 py 文件是同仓库原样 vendored
（一行不改），所以只能这样做。如果哪天上游给这些路径加了环境变量支持，
这个 launcher 就可以退休（见 THIRD-PARTY 说明）。
"""
import os
import sys

# 绝不在包目录里留 __pycache__：包可能是全局 npm 安装（只读），
# 而且脏文件会进 git 工作树。插件侧也传了 PYTHONDONTWRITEBYTECODE=1，
# 这里再兜一层 —— 用户手工直接跑 run.py 时同样干净。
sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def _state_dir():
    """记忆数据目录 —— **就是 node 侧 memoryStateDir(cfg) 的值**（经环境变量传进来）。

    为什么要统一（P1-4 的 split-brain 修法）：
      node 侧 memoryEnv() 现在把桥、调度器、设置页、导出全部指向同一个
      memoryStateDir(cfg)，通过 LLMINQQ_STATE_DIR 传给 python。这里如果还按
      别的口径算（或者允许第二个变量名），就会出现「桥写的库」和「调度器读的库」
      不是同一份 —— python 侧只认这一个变量，不再另造名字。
    缺变量 → 报错退出（绝不默默落到包目录里写数据：npm 包只读，升级会冲掉记忆）。
    """
    d = os.environ.get("LLMINQQ_STATE_DIR") or ""
    if not d:
        sys.stderr.write(
            "run.py: 缺少 LLMINQQ_STATE_DIR（插件应设置它指向 memoryStateDir(cfg)）\n")
        sys.exit(1)
    return os.path.abspath(os.path.expanduser(d))


def _bridge_log():
    # 记忆的 ingest 读桥日志里的「入站/出站」行。脚本版默认 仓库根/logs/bridge.out；
    # 插件版日志在 <stateDir>/../logs/bridge.out（由 lib/index.js 重定向），
    # 但最终以环境变量为准，别在 python 侧猜。
    return os.environ.get("LLMINQQ_BRIDGE_LOG") or os.path.join(_state_dir(), "bridge.out")


def run_memctl(state, args):
    import memctl as m
    m.DB = os.path.join(state, "mem.db")
    m.LOG_DIR = os.path.join(state, "log")
    m.CURSOR = os.path.join(state, ".ingest_cursor")
    m.DIGEST = os.path.join(state, "digest.md")
    m.BRIDGE_LOG = _bridge_log()
    sys.argv = ["memctl.py"] + args
    return m.main()


def run_stylebank(state, args):
    import stylebank as s
    s.STYLE_DB = os.path.join(state, "style.db")
    s.STYLE_JSONL = os.path.join(state, "style-cases.jsonl")
    s.CURSOR_JSONL = os.path.join(state, ".style_cursor")
    s.CURSOR_LOG = os.path.join(state, ".style_cursor_log")
    sys.argv = ["stylebank.py"] + args
    return s.main()


def run_lexicon(state, args):
    import lexicon as lx
    lx.LEXICON_PATH = os.path.join(state, "lexicon.json")
    lx.LOG_DIR = os.path.join(state, "log")
    lx.CORPUS_DEFAULT_DIR = os.path.join(state, "corpus")
    cfg = os.environ.get("LLMINQQ_CONFIG")
    if cfg:
        lx.CONFIG_PATH = cfg
    sys.argv = ["lexicon.py"] + args
    return lx.main()


TOOLS = {"memctl": run_memctl, "stylebank": run_stylebank, "lexicon": run_lexicon}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in TOOLS:
        sys.stderr.write("用法: run.py {memctl|stylebank|lexicon} <该工具的原有参数...>\n")
        return 2
    tool = sys.argv[1]
    return TOOLS[tool](_state_dir(), sys.argv[2:])


if __name__ == "__main__":
    sys.exit(main())
