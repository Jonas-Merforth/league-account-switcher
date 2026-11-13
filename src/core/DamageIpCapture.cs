using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;

public static class DamageIpCapture
{
    private const long FileLimit = 128 * 1024 * 1024;
    private const long UnixEpoch = 621355968000000000L;

    [DllImport("iphlpapi.dll")]
    private static extern uint GetExtendedUdpTable(IntPtr table, ref int size, bool sort, int family, int kind, uint reserved);

    private static HashSet<int> ReadPorts(int pid)
    {
        var ports = new HashSet<int>();
        int size = 0;
        GetExtendedUdpTable(IntPtr.Zero, ref size, false, 2, 1, 0);
        if (size < 4 || size > 4 * 1024 * 1024) return ports;
        IntPtr table = Marshal.AllocHGlobal(size);
        try {
            if (GetExtendedUdpTable(table, ref size, false, 2, 1, 0) != 0) return ports;
            int count = Marshal.ReadInt32(table);
            if (count > (size - 4) / 12) return ports;
            for (int i = 0; i < count; i++) {
                int row = 4 + 12 * i;
                if (Marshal.ReadInt32(table, row + 8) == pid)
                    ports.Add((Marshal.ReadByte(table, row + 4) << 8) | Marshal.ReadByte(table, row + 5));
            }
            return ports;
        } finally { Marshal.FreeHGlobal(table); }
    }

    private static bool SameAddress(byte[] packet, int offset, byte[] address)
    {
        for (int i = 0; i < 4; i++) if (packet[offset + i] != address[i]) return false;
        return true;
    }

    private static void WriteHeaders(BinaryWriter writer)
    {
        writer.Write(0x0a0d0d0a); writer.Write(28); writer.Write(0x1a2b3c4d);
        writer.Write((ushort)1); writer.Write((ushort)0); writer.Write(-1L); writer.Write(28);
        writer.Write(1); writer.Write(20); writer.Write((ushort)228); writer.Write((ushort)0);
        writer.Write(65535); writer.Write(20);
    }

    public static void Run(string dir, int pid, long startTicks, IPAddress peer, int serverPort, DateTime deadline)
    {
        IPAddress local;
        using (var route = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp)) {
            route.Connect(peer, serverPort);
            local = ((IPEndPoint)route.LocalEndPoint).Address;
        }
        var localBytes = local.GetAddressBytes();
        var peerBytes = peer.GetAddressBytes();
        byte[] packet = new byte[65535];
        byte[] padding = new byte[3];
        using (var observer = new Socket(AddressFamily.InterNetwork, SocketType.Raw, ProtocolType.IP))
        using (var game = Process.GetProcessById(pid)) {
            if (game.StartTime.ToUniversalTime().Ticks != startTicks) throw new InvalidOperationException();
            observer.Bind(new IPEndPoint(local, 0));
            observer.ReceiveBufferSize = 4 * 1024 * 1024;
            observer.ReceiveTimeout = 100;
            observer.IOControl(IOControlCode.ReceiveAll, BitConverter.GetBytes(3), null);
            using (var file = new FileStream(Path.Combine(dir, "raw-ipv4.pcapng"), FileMode.CreateNew, FileAccess.Write, FileShare.Read))
            using (var writer = new BinaryWriter(file)) {
                WriteHeaders(writer);
                writer.Flush();
                var nextCheck = DateTime.MinValue;
                var ports = new HashSet<int>();
                var stop = Path.Combine(dir, "stop");
                var heartbeat = Path.Combine(dir, "heartbeat");
                while (DateTime.UtcNow < deadline) {
                    DateTime now = DateTime.UtcNow;
                    if (now >= nextCheck) {
                        writer.Flush();
                        if (game.HasExited || File.Exists(stop) || (now - File.GetLastWriteTimeUtc(heartbeat)).TotalSeconds > 30) break;
                        ports = ReadPorts(pid);
                        nextCheck = now.AddMilliseconds(100);
                    }
                    int count;
                    try { count = observer.Receive(packet); }
                    catch (SocketException error) {
                        if (error.SocketErrorCode == SocketError.TimedOut) continue;
                        throw;
                    }
                    if (count < 28 || packet[0] >> 4 != 4 || packet[9] != 17 || ((packet[6] & 63) | packet[7]) != 0) continue;
                    int header = (packet[0] & 15) * 4;
                    int size = (packet[2] << 8) | packet[3];
                    if (header < 20 || size < header + 8 || size > count || ((packet[header + 4] << 8) | packet[header + 5]) != size - header) continue;
                    int source = (packet[header] << 8) | packet[header + 1];
                    int dest = (packet[header + 2] << 8) | packet[header + 3];
                    bool incoming = source == serverPort && ports.Contains(dest) && SameAddress(packet, 12, peerBytes) && SameAddress(packet, 16, localBytes);
                    bool outgoing = dest == serverPort && ports.Contains(source) && SameAddress(packet, 12, localBytes) && SameAddress(packet, 16, peerBytes);
                    if (!incoming && !outgoing) continue;
                    long ticks = (DateTime.UtcNow.Ticks - UnixEpoch) / 10;
                    int pad = (4 - (size & 3)) & 3;
                    int block = 32 + size + pad;
                    if (file.Position + block > FileLimit) throw new IOException("Capture limit reached");
                    writer.Write(6); writer.Write(block); writer.Write(0);
                    writer.Write((uint)(ticks >> 32)); writer.Write((uint)ticks);
                    writer.Write(size); writer.Write(size); writer.Write(packet, 0, size);
                    writer.Write(padding, 0, pad); writer.Write(block);
                }
            }
        }
    }
}
