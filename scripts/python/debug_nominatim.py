import asyncio
import logging

# Mock logger
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

CONTAINER_START_TIMEOUT = 120


async def check_container_running(service_name: str) -> bool:
    return False


# Mock for asyncio.create_subprocess_exec
class MockProcess:
    def __init__(self, returncode, stderr_content):
        self.returncode = returncode
        self.stderr_content = stderr_content
        self.stdout = self
        self.stderr = self

    async def communicate(self):
        return (b"", self.stderr_content)

    def decode(self):
        return ""  # Not used directly on process, but on stderr output


# To simulate different scenarios, we'll patch this function dynamically in tests


async def start_container_on_demand(
    service_name: str,
    mock_scenarios: list,  # List of (returncode, stderr) for each call
) -> bool:
    # Copied logic (simplified imports)

    # Check if already running
    if await check_container_running(service_name):
        logger.info("Container %s is already running", service_name)
        return True

    logger.info("Starting container %s on demand...", service_name)

    compose_commands = [
        ["docker", "compose", "up"],
        ["docker-compose", "up"],
    ]

    last_error = "No docker compose command found"

    scenario_idx = 0

    for _cmd in compose_commands:
        try:
            # consumes one scenario
            if scenario_idx >= len(mock_scenarios):
                logger.error("Not enough scenarios")
                break

            rc, stderr_bytes = mock_scenarios[scenario_idx]
            scenario_idx += 1

            # Simulate process
            # In real code: await asyncio.create_subprocess_exec(...)

            # Simulate communicate
            _stdout, stderr = (b"", stderr_bytes)

            error_msg = stderr.decode() if stderr else ""

            # Check logic from code
            if rc != 0 and (
                "unknown shorthand flag" in error_msg
                or "is not a docker command" in error_msg
                or "'compose' is not a docker command" in error_msg
            ):
                logger.debug("Docker Compose V2 not available...")
                continue

            if rc == 0:
                logger.info("Success path (simulated)")
                return True

            last_error = error_msg or "Unknown error"
            logger.debug("Command failed: %s", last_error)

        except FileNotFoundError:
            continue
        except RuntimeError:
            raise

    # Fallback logic
    logger.info("Fallback...")

    try:
        # consume scenario for fallback
        if scenario_idx < len(mock_scenarios):
            rc, stderr_bytes = mock_scenarios[scenario_idx]
            scenario_idx += 1

            # Simulate process
            _stdout, stderr = (b"", stderr_bytes)

            if rc == 0:
                return True

            error_msg = stderr.decode() if stderr else "Unknown error"
            last_error = f"Fallback failed: {error_msg}"
        else:
            # If we run out of scenarios, maybe exception raised
            pass

    except Exception as e:
        last_error = f"Fallback error: {e}"

    logger.error("Failed to start container %s: %s", service_name, last_error)
    return f"Failed to start {service_name}: {last_error}"
    # raise RuntimeError(msg)


async def run_tests():
    print("--- Test 1: All fail with empty stderr ---")
    # 1. docker compose -> fail, stderr empty
    # 2. docker-compose -> fail, stderr empty
    # 3. fallback -> fail, stderr empty
    scenarios = [(1, b""), (1, b""), (1, b"")]
    res = await start_container_on_demand("nominatim", scenarios)
    print(f"Result: {res!r}")  # Expect "Fallback failed: Unknown error"

    print("\n--- Test 2: Fallback Exception ---")
    # 1. fail
    # 2. fail
    # 3. Raise exception (simulated by logic consuming all scenarios and falling into except block?)
    # Wait, my mock doesn't simulate raising Exception in fallback unless I add logic.
    # Let's rely on code inspection for exception.

    print("\n--- Test 3: Stderr is None string? ---")
    scenarios = [(1, b"None"), (1, b"None"), (1, b"None")]
    res = await start_container_on_demand("nominatim", scenarios)
    print(f"Result: {res!r}")

    print("\n--- Test 4: Can last_error be None string? ---")
    # To get "Failed to start nominatim: None", last_error must be "None".
    # last_error = "Fallback failed: None" (if stderr is b"None")
    # last_error = "None" ?

    # If error_msg is "None" -> last_error = "Fallback failed: None"

    # Is there ANY path?


if __name__ == "__main__":
    asyncio.run(run_tests())
