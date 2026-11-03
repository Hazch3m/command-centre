"""A tiny MCP server with garmin-coach's tool names, used by the Rust tests to
check the app's MCP client end to end (start, handshake, list tools, call)."""
try:
    from mcp.server.mcpserver import MCPServer as Server
except ImportError:
    from mcp.server.fastmcp import FastMCP as Server

mcp = Server("garmin-coach")


@mcp.tool(description="Check a workout and return a readable summary.")
def preview_workout(name: str, steps: list[dict], sport: str = "running", description: str | None = None) -> str:
    return f"{name} ({sport}) with {len(steps)} steps"


@mcp.tool(description="List workouts on the Garmin calendar between two dates.")
def get_scheduled(start_date: str, end_date: str) -> list[dict]:
    return [{"date": start_date, "name": "Easy 8 km", "workoutId": 1, "scheduleId": 2}]


if __name__ == "__main__":
    mcp.run()
