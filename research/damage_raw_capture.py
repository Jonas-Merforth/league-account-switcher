"""Compare Windows IP-layer capture with a running damage test recorder.

Run elevated. The socket observes IPv4 on the route to the game server.
Only UDP matching the exact game server and game-owned port is written.
The observer exits with the existing recorder, and sends no traffic.
"""
import argparse
import datetime as dt
import ipaddress
import json
import os
import re
import socket
import struct
import time
from pathlib import Path


def status_at(directory):
    try:
        return json.loads((directory / 'status.json').read_text(encoding='utf-8'))
    except (FileNotFoundError, PermissionError, json.JSONDecodeError):
        return {}


def active(directory):
    if (directory / 'stop').exists():
        return False
    try:
        return time.time() - (directory / 'heartbeat').stat().st_mtime < 35
    except FileNotFoundError:
        return False


def server_from_log(league, started_at):
    """Find the freshly created game log and extract only its remote endpoint."""
    start = dt.datetime.fromisoformat(started_at.replace('Z', '+00:00')).timestamp()
    matches = []
    for log in (league / 'Logs' / 'GameLogs').glob('*/*_r3dlog.txt'):
        try:
            stat = log.stat()
            born = getattr(stat, 'st_birthtime', stat.st_ctime)
            if start - 45 <= born <= start + 10:
                matches.append(log)
        except FileNotFoundError:
            continue
    if len(matches) != 1:
        return None
    with matches[0].open(encoding='utf-8', errors='replace') as stream:
        for index, line in enumerate(stream):
            if index >= 200:
                break
            if 'Command' not in line:
                continue
            match = re.search(r'"([0-9.]+) ([0-9]+) \S+ [0-9]+"', line)
            if match:
                ip, port = ipaddress.IPv4Address(match[1]), int(match[2])
                if 0 < port < 65536:
                    return ip, port
    return None


def block(kind, body):
    body += bytes(-len(body) % 4)
    size = len(body) + 12
    return struct.pack('<II', kind, size) + body + struct.pack('<I', size)


def game_packet(packet, remote, local, server_port, local_ports):
    if len(packet) < 28 or packet[0] >> 4 != 4 or packet[9] != socket.IPPROTO_UDP:
        return None
    header = (packet[0] & 15) * 4
    total = int.from_bytes(packet[2:4], 'big')
    if header < 20 or not header + 8 <= total <= len(packet) or int.from_bytes(packet[6:8], 'big') & 0x3fff:
        return None
    source, dest, udp_size = struct.unpack_from('>HHH', packet, header)
    if udp_size + header != total:
        return None
    if packet[12:16] == remote and source == server_port and packet[16:20] == local and dest in local_ports:
        return 'in', packet[:total]
    if packet[12:16] == local and source in local_ports and packet[16:20] == remote and dest == server_port:
        return 'out', packet[:total]
    return None


def capture(session, league, summary):
    if os.name != 'nt':
        raise ValueError('The IP-layer observer requires Windows')
    directory = session / 'observations.packets'
    deadline = time.monotonic() + 7200
    while active(directory) and time.monotonic() < deadline:
        state = status_at(directory)
        if state.get('state') in ('complete', 'error', 'converting'):
            return
        if state.get('startedAt') and state.get('ports'):
            peer = server_from_log(league, state['startedAt'])
            if peer:
                break
            if time.time() - dt.datetime.fromisoformat(state['startedAt'].replace('Z', '+00:00')).timestamp() > 30:
                raise ValueError('No unambiguous current game log')
        time.sleep(.2)
    else:
        return
    remote, server_port = peer
    # A UDP connect selects the route and does not send a datagram.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as route:
        route.connect((str(remote), server_port))
        local = ipaddress.IPv4Address(route.getsockname()[0])
    with socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_IP) as observer:
        observer.bind((str(local), 0))
        observer.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 * 1024 * 1024)
        observer.settimeout(.2)
        observer.ioctl(socket.SIO_RCVALL, 3)  # RCVALL_IPLEVEL, no NIC promiscuous mode
        try:
            with (session / 'raw-ipv4.pcapng').open('xb') as file:
                file.write(block(0x0a0d0d0a, struct.pack('<IHHq', 0x1a2b3c4d, 1, 0, -1)))
                file.write(block(1, struct.pack('<HHI', 228, 0, 65535)))  # LINKTYPE_IPV4
                summary['startedAt'] = time.time()
                check_at = 0
                ports = set()
                while time.monotonic() < deadline:
                    if time.monotonic() >= check_at:
                        check_at = time.monotonic() + 1
                        state = status_at(directory)
                        if not active(directory) or state.get('state') in ('complete', 'error', 'converting'):
                            break
                        ports.update(state.get('ports') or ())
                    try:
                        raw = observer.recv(65535)
                    except TimeoutError:
                        continue
                    match = game_packet(raw, remote.packed, local.packed, server_port, ports)
                    if match is None:
                        continue
                    direction, packet = match
                    ticks = time.time_ns() // 1000
                    header = struct.pack('<5I', 0, ticks >> 32, ticks & 0xffffffff, len(packet), len(packet))
                    file.write(block(6, header + packet))
                    summary[direction] += 1
                    if file.tell() >= 128 * 1024 * 1024:
                        summary['limitReached'] = True
                        break
        finally:
            observer.ioctl(socket.SIO_RCVALL, socket.RCVALL_OFF)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--session', type=Path, required=True)
    parser.add_argument('--league-path', type=Path, required=True)
    args = parser.parse_args()
    summary = {'in': 0, 'out': 0}
    try:
        capture(args.session, args.league_path, summary)
    except (OSError, ValueError) as error:
        # Keep local diagnostics free of raw packet content or log lines.
        summary['error'] = error.winerror if isinstance(error, OSError) and hasattr(error, 'winerror') else type(error).__name__
    finally:
        (args.session / 'raw-ipv4-summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
    return 1 if 'error' in summary else 0


if __name__ == '__main__':
    raise SystemExit(main())
