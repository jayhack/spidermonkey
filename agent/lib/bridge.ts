export async function callBridge(name: string, input: Record<string, unknown>, signal?: AbortSignal) {
  const url = process.env.ROS_BRIDGE_URL;
  const token = process.env.ROS_BRIDGE_TOKEN;
  if (!url || !token) throw new Error('Start this agent with pnpm start or pnpm demo:live');
  const response = await fetch(`${url}/tool`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name, input }), signal,
  });
  if (!response.ok) throw new Error(`Tool bridge returned ${response.status}`);
  return response.json();
}
