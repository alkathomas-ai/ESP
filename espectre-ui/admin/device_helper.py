"""Reuse ESPectre host tooling; Wi-Fi credentials exist only in process memory."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'espectre' / 'src' / 'python'))

def run(request):
    operation = request['operation']
    if operation == 'serial':
        from serial.tools.list_ports import comports
        return [{'port': p.device, 'description': p.description, 'vid': p.vid, 'pid': p.pid}
                for p in comports() if p.vid is not None]
    if operation == 'discover':
        from espectre_cli.device_discovery import discover_devices
        return [d.as_serializable_dict() for d in discover_devices(timeout_s=3)]
    if operation == 'provision':
        from serial.tools.list_ports import comports
        from espectre_cli.device_transport import ImprovSerialClient, direct_endpoint_from_device_url
        port = request['port']
        if port not in [p.device for p in comports() if p.vid is not None]:
            raise ValueError('Selected USB serial port is no longer connected')
        with ImprovSerialClient(port) as client:
            result = client.provision(request['ssid'], request['password'], timeout=60)
        return {'endpoint': direct_endpoint_from_device_url(result.endpoint)}
    raise ValueError('Unknown operation')

try:
    request = json.loads(sys.stdin.buffer.read(16385))
    result = run(request)
    print(json.dumps({'ok': True, 'result': result}))
except Exception:
    # Never echo exceptions from serial/protocol code: they might contain credentials.
    print(json.dumps({'ok': False, 'error': 'Device operation failed. Check USB connection, firmware Improv support, or network access.'}))
    sys.exit(1)
