import argparse
import asyncio
import logging
import signal

from . import VERSION
from . import logbook
from .agent import Agent
from .config import load


def main():
    parser = argparse.ArgumentParser(prog="gramsetu-speaker", description="GramSetu speaker node agent")
    parser.add_argument("--config", help="path to config.json (default: $GRAMSETU_CONFIG or /etc/gramsetu-speaker/config.json)")
    parser.add_argument("--debug", action="store_true")
    parser.add_argument("--version", action="version", version=VERSION)
    args = parser.parse_args()

    console = logging.StreamHandler()
    console.setLevel(logging.DEBUG if args.debug else logging.INFO)
    console.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.setLevel(logging.DEBUG)
    root.addHandler(console)
    logging.getLogger("asyncio").setLevel(logging.INFO)

    config = load(args.config)
    book = logbook.install(config.log_level)
    logging.getLogger("agent").info("GramSetu speaker %s starting as %s", VERSION, config.device_id)

    async def run():
        task = asyncio.create_task(Agent(config, book).run())
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, task.cancel)
        try:
            await task
        except asyncio.CancelledError:
            pass

    asyncio.run(run())


if __name__ == "__main__":
    main()
