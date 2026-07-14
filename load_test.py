#!/usr/bin/env python3
"""
无痕访问压测脚本
- 目标: https://beta.zcool.com.cn
- QPS: 10
- 时长: 2 分钟
- 无痕: 每次请求不携带 cookie，模拟全新访问
"""

import asyncio
import time
import statistics
import random
import string
from dataclasses import dataclass, field
from typing import List

import aiohttp

# ── 配置 ──────────────────────────────────────────────
TARGET_URL = "https://beta.zcool.com.cn/"
QPS = 20
DURATION_SECONDS = 120  # 2 分钟
CONCURRENCY = 60        # 最大并发连接数

# 随机 User-Agent 列表，模拟真实无痕访问
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
]


@dataclass
class RequestResult:
    status: int = 0
    latency_ms: float = 0.0
    error: str = ""
    success: bool = False


@dataclass
class Stats:
    total: int = 0
    success: int = 0
    failed: int = 0
    latencies: List[float] = field(default_factory=list)
    status_codes: dict = field(default_factory=dict)
    errors: List[str] = field(default_factory=list)
    start_time: float = 0.0
    end_time: float = 0.0


async def single_request(session: aiohttp.ClientSession, url: str) -> RequestResult:
    """发送一次无痕请求（不携带 cookie）"""
    headers = {
        "User-Agent": random.choice(USER_AGENTS),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    }
    result = RequestResult()
    start = time.monotonic()
    try:
        async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=15)) as resp:
            await resp.read()  # 消费 body
            result.status = resp.status
            result.success = 200 <= resp.status < 400
    except Exception as e:
        result.error = str(e)[:120]
    result.latency_ms = (time.monotonic() - start) * 1000
    return result


async def rate_limited_sender(
    session: aiohttp.ClientSession,
    url: str,
    qps: int,
    duration: int,
    stats: Stats,
    semaphore: asyncio.Semaphore,
):
    """按固定 QPS 发送请求，每个请求在独立的任务中执行"""
    interval = 1.0 / qps
    end_time = time.monotonic() + duration
    count = 0

    async def _do_request():
        async with semaphore:
            r = await single_request(session, url)
            stats.total += 1
            if r.success:
                stats.success += 1
            else:
                stats.failed += 1
                if r.error:
                    stats.errors.append(r.error)
            stats.latencies.append(r.latency_ms)
            stats.status_codes[r.status] = stats.status_codes.get(r.status, 0) + 1

    while time.monotonic() < end_time:
        asyncio.create_task(_do_request())
        count += 1
        # 精确控制发送间隔
        next_tick = stats.start_time + count * interval
        sleep_time = next_tick - time.monotonic()
        if sleep_time > 0:
            await asyncio.sleep(sleep_time)

    # 等待剩余请求完成
    await asyncio.sleep(2)


def print_report(stats: Stats, qps: int, duration: int):
    """输出压测报告"""
    elapsed = stats.end_time - stats.start_time
    print("\n" + "=" * 60)
    print("              📊 无痕访问压测报告")
    print("=" * 60)
    print(f"  目标地址:    {TARGET_URL}")
    print(f"  目标 QPS:    {qps}")
    print(f"  压测时长:    {duration} 秒")
    print(f"  实际耗时:    {elapsed:.1f} 秒")
    print(f"  并发上限:    {CONCURRENCY}")
    print("-" * 60)

    print(f"  总请求数:    {stats.total}")
    print(f"  成功数:      {stats.success}")
    print(f"  失败数:      {stats.failed}")
    if stats.total > 0:
        print(f"  成功率:      {stats.success / stats.total * 100:.1f}%")
        print(f"  实际 QPS:    {stats.total / elapsed:.1f}")

    if stats.latencies:
        lat = stats.latencies
        print("-" * 60)
        print("  ⏱️  延迟统计 (ms):")
        print(f"    最小值:    {min(lat):.0f}")
        print(f"    最大值:    {max(lat):.0f}")
        print(f"    平均值:    {statistics.mean(lat):.0f}")
        print(f"    中位数:    {statistics.median(lat):.0f}")
        if len(lat) >= 2:
            print(f"    标准差:    {statistics.stdev(lat):.0f}")
        sorted_lat = sorted(lat)
        p90_idx = int(len(sorted_lat) * 0.9)
        p95_idx = int(len(sorted_lat) * 0.95)
        p99_idx = int(len(sorted_lat) * 0.99)
        print(f"    P90:       {sorted_lat[min(p90_idx, len(sorted_lat)-1)]:.0f}")
        print(f"    P95:       {sorted_lat[min(p95_idx, len(sorted_lat)-1)]:.0f}")
        print(f"    P99:       {sorted_lat[min(p99_idx, len(sorted_lat)-1)]:.0f}")

    if stats.status_codes:
        print("-" * 60)
        print("  📦 状态码分布:")
        for code, cnt in sorted(stats.status_codes.items()):
            bar = "█" * min(cnt * 40 // max(stats.status_codes.values()), 40)
            print(f"    {code:>3}: {cnt:>5}  {bar}")

    if stats.errors:
        print("-" * 60)
        print(f"  ❌ 错误采样 (前 5 条):")
        for e in stats.errors[:5]:
            print(f"    - {e}")

    print("=" * 60 + "\n")


async def main():
    print(f"🚀 开始压测: {TARGET_URL}")
    print(f"   QPS={QPS}  时长={DURATION_SECONDS}s  并发上限={CONCURRENCY}")
    print(f"   模式: 无痕访问（无 cookie / 无缓存 / 随机 UA）\n")

    stats = Stats()
    semaphore = asyncio.Semaphore(CONCURRENCY)

    # 不共享 cookie — 每个请求都是全新连接
    connector = aiohttp.TCPConnector(limit=CONCURRENCY, force_close=True)
    async with aiohttp.ClientSession(connector=connector, cookie_jar=None) as session:
        stats.start_time = time.monotonic()
        await rate_limited_sender(session, TARGET_URL, QPS, DURATION_SECONDS, stats, semaphore)
        stats.end_time = time.monotonic()

    print_report(stats, QPS, DURATION_SECONDS)


if __name__ == "__main__":
    asyncio.run(main())
