#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
transcribe.py —— 把一段音频（QQ 语音）转成文字，**纯文本打到 stdout**。

给 dsh-plugin-llminqq 的「语音转文字」用：桥先把 QQ 语音段里的 url 下到暂存区，
再把本地文件路径交给这个脚本。约定只有一条、但必须严格：
  · stdout 只放**转写文本**（调用方直接 trim 后进上下文）；
  · 进度 / 模型加载 / 报错一律走 stderr —— 打到 stdout 就会被当成转写内容。

用法（桥会自动带 --file；手动调试时也一样）：
    python3 transcribe.py --file /tmp/xxx.amr
    python3 transcribe.py --file a.amr --model base --lang zh
    python3 transcribe.py --file a.amr --engine funasr        # 可选，环境有才用

两个引擎：
  ① faster-whisper（默认）—— CPU + int8，模型 tiny/base/small/medium。
  ② funasr（可选，默认不用）—— 中文场景不错；**没装（import 失败）时自动回退
     faster-whisper**；能 import 但转写本身报错就直接报错（不再烧一次 CPU 重跑）。

首次使用成本（必须让用户知道，否则「开了没反应」会被当成 bug）：
  · 依赖：pip install faster-whisper（装进哪个 python 由 config 的 pythonBin 决定）
  · 模型：第一次运行会从 HuggingFace **镜像**下载，之后本地缓存、不再下载：

        tiny    ≈  75 MB      base ≈ 145 MB
        small   ≈ 480 MB      medium ≈ 1.5 GB

  · CPU int8 上一条 10 秒语音的粗略耗时（4 核以上现代 CPU）：
        tiny/base 约 1–3 秒；small 约 3–8 秒；medium 约 10–25 秒。
  · 模型缓存放 `HF_HOME`（桥传的是插件数据目录下的 agent/asr-models/），
    删掉它 = 下次重新下载。

为什么要钉 HF 镜像和关掉 Xet：国内直连 huggingface.co 基本拉不动；
HuggingFace 新存储（Xet）国内镜像不代理，不关会 401（legacy 脚本踩过）。

退出码：0 成功（stdout 可能为空 = 静音/没听清）；2 音频文件不存在；
        3 缺 faster-whisper 依赖；1 其它转写失败。所有失败原因都写 stderr。
"""

import argparse
import os
import sys


def _utf8_stdio():
    """Windows 上 Python 默认按 GBK 编解码管道 —— 中文打进 stdout 会炸/乱码。"""
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass


def _setup_hf(hf_home):
    """
    必须在 import faster_whisper **之前**调用，否则它已经按默认值去连 HF 了。

    为什么用 setdefault 而不是直接覆盖：用户显式设了 HF_ENDPOINT / HF_HOME
    （比如公司代理、已经下好的缓存目录）就以用户的为准，我们只补默认值。
    """
    os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')
    if hf_home:
        os.environ.setdefault('HF_HOME', os.path.abspath(hf_home))
    # HuggingFace 新存储后端 Xet：国内镜像不代理它 ⇒ 关掉走老 CDN（否则 401）
    os.environ.setdefault('HF_HUB_DISABLE_XET', '1')


def _run_faster_whisper(path, model_size, lang, device, compute_type):
    """返回 (text, exit_code)；exit_code 非 0 时 text 为 None。"""
    try:
        from faster_whisper import WhisperModel
    except Exception as e:
        print('[asr] 缺少 faster-whisper 依赖：%s' % e, file=sys.stderr)
        print('[asr] 装它：<pythonBin> -m pip install faster-whisper', file=sys.stderr)
        return None, 3

    print('[asr] 加载模型 %s（首次会自动下模型，之后本地读）…' % model_size, file=sys.stderr)
    model = WhisperModel(model_size, device=device, compute_type=compute_type)
    print('[asr] 开始转写…', file=sys.stderr)
    segments, _info = model.transcribe(
        path,
        language=None if str(lang).strip() in ('', 'auto') else lang,
        vad_filter=True,      # 掐掉静音段：省时间，也少一些「嗯…啊…」的误转
    )
    text = ''.join(seg.text for seg in segments).strip()
    return text, 0


def _run_funasr(path, model_size, lang):
    """
    可选引擎。返回 (text, exit_code, used)。
    used=False 表示 funasr 不可用 → 调用方回退 faster-whisper。
    FunASR 的模型名和 whisper 的 tiny/base/small 不是一套，所以 --model 对它无效
    （保留参数只是为了兼容命令行）；模型名用环境变量 LLMINQQ_FUNASR_MODEL 覆盖，
    默认中文通用 paraformer-zh。
    """
    try:
        from funasr import AutoModel
    except Exception as e:
        print('[asr] funasr 不可用（%s），回退 faster-whisper' % e, file=sys.stderr)
        return None, 0, False
    model_id = os.environ.get('LLMINQQ_FUNASR_MODEL') or 'paraformer-zh'
    print('[asr] 加载 FunASR 模型 %s…' % model_id, file=sys.stderr)
    model = AutoModel(model=model_id, vad_model='fsmn-vad', punc_model='ct-punc')
    res = model.generate(input=path, batch_size_s=300)
    text = ''.join(
        str(x.get('text', '')) for x in (res or []) if isinstance(x, dict)
    ).strip()
    return text, 0, True


def main():
    _utf8_stdio()
    ap = argparse.ArgumentParser(description='把一段音频转成文字（QQ 语音）')
    ap.add_argument('--file', required=True, help='本地音频文件路径')
    ap.add_argument('--model', default='small',
                    help='whisper 模型大小：tiny / base / small / medium（默认 small）')
    ap.add_argument('--lang', default='zh', help='语言代码：zh / en / ja…；auto = 自动判断')
    ap.add_argument('--engine', default='faster-whisper',
                    choices=['faster-whisper', 'funasr'],
                    help='引擎（默认 faster-whisper；funasr 不可用时自动回退）')
    ap.add_argument('--device', default=os.environ.get('LLMINQQ_ASR_DEVICE', 'cpu'))
    ap.add_argument('--compute-type',
                    default=os.environ.get('LLMINQQ_ASR_COMPUTE_TYPE', 'int8'))
    ap.add_argument('--hf-home', default=os.environ.get('HF_HOME', ''),
                    help='模型缓存目录（默认用环境变量 HF_HOME；桥会传插件数据目录）')
    args = ap.parse_args()

    src = os.path.abspath(os.path.expanduser(args.file))
    if not os.path.isfile(src):
        print('[asr] 音频文件不存在：%s' % src, file=sys.stderr)
        return 2

    _setup_hf(args.hf_home)

    try:
        if args.engine == 'funasr':
            text, code, used = _run_funasr(src, args.model, args.lang)
            if used:
                if code != 0:
                    return code
                print(text)
                return 0
            # funasr 不可用 → 落到下面的 faster-whisper
        text, code = _run_faster_whisper(
            src, args.model, args.lang, args.device, args.compute_type)
        if code != 0:
            return code
        print(text)
        return 0
    except Exception as e:
        # 模型下载失败 / 音频解码失败 / 显存/内存不足 都走这里：stderr 给原因，
        # 调用方降级成「没转写成功」，绝不把整轮回复拖死。
        print('[asr] 转写失败：%s' % e, file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
