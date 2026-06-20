import asyncio
import unittest

from core.manager import GenerationBusyError, ModelManager


class GenerationBackpressureTests(unittest.TestCase):
    """The generation lock serializes image generation. When too many requests
    already wait for it, new ones must be rejected fast (mapped to HTTP 429) so
    pending coroutines do not pile up without bound.

    Each test builds a fresh ModelManager: its asyncio.Lock must live on the same
    event loop that uses it, and asyncio.run() creates a new loop per test."""

    def test_cap_rejects_when_wait_queue_is_full(self):
        async def scenario():
            mgr = ModelManager()
            mgr.max_generation_waiters = 1
            await mgr.generation_lock.acquire()  # hold so all entrants must wait
            try:
                async def hold_session():
                    async with mgr.generation_session("r1"):
                        pass

                waiter = asyncio.create_task(hold_session())

                # Wait until r1 is parked on the lock (becomes the single waiter).
                for _ in range(200):
                    if mgr._generation_waiters == 1:
                        break
                    await asyncio.sleep(0.005)
                self.assertEqual(mgr._generation_waiters, 1)

                # Queue is full -> r2 is rejected immediately, without piling up.
                with self.assertRaises(GenerationBusyError):
                    async with mgr.generation_session("r2"):
                        pass

                # Release the lock so the legitimate waiter drains cleanly.
                mgr.generation_lock.release()
                await waiter
                self.assertEqual(mgr._generation_waiters, 0)
            finally:
                if mgr.generation_lock.locked():
                    mgr.generation_lock.release()

        asyncio.run(scenario())

    def test_cap_disabled_allows_unbounded_waiters(self):
        async def scenario():
            mgr = ModelManager()
            mgr.max_generation_waiters = 0  # disabled
            await mgr.generation_lock.acquire()
            try:
                async def hold_session(rid):
                    async with mgr.generation_session(rid):
                        pass

                tasks = [asyncio.create_task(hold_session(f"r{i}")) for i in range(5)]
                for _ in range(200):
                    if mgr._generation_waiters == 5:
                        break
                    await asyncio.sleep(0.005)
                self.assertEqual(mgr._generation_waiters, 5)  # no rejection
                mgr.generation_lock.release()
                await asyncio.gather(*tasks)
            finally:
                if mgr.generation_lock.locked():
                    mgr.generation_lock.release()

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
