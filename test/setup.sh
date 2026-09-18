#!/usr/bin/env bash
# Creates what the tests need and the repository does not carry: the colour-bar test streams
# (same box layout as Bilibili's DASH files: ftyp moov sidx moof/mdat…) and a throw-away TLS
# certificate for the mock server. Needs ffmpeg (libvpx-vp9, libopus, libsvtav1, libx265) and openssl.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p media certs
FLAGS="-movflags +frag_keyframe+empty_moov+default_base_moof+global_sidx -f mp4"
SRC720="testsrc2=size=1280x720:rate=25,format=yuv420p"
SRC360="testsrc2=size=640x360:rate=25,format=yuv420p"
[ -f media/v720.m4s ] || ffmpeg -v error -y -f lavfi -i "$SRC720" -t 90 -c:v libvpx-vp9 -b:v 1800k -minrate 1500k -maxrate 2200k -deadline realtime -cpu-used 8 -row-mt 1 -g 125 -keyint_min 125 -an $FLAGS media/v720.m4s
[ -f media/v360.m4s ] || ffmpeg -v error -y -f lavfi -i "$SRC360" -t 90 -c:v libvpx-vp9 -b:v 500k -deadline realtime -cpu-used 8 -g 125 -keyint_min 125 -an $FLAGS media/v360.m4s
[ -f media/v720_av1.m4s ] || ffmpeg -v error -y -f lavfi -i "$SRC720" -t 90 -c:v libsvtav1 -preset 12 -b:v 1500k -g 125 -keyint_min 125 -svtav1-params "scd=0" -an $FLAGS media/v720_av1.m4s
[ -f media/a96.m4s ] || ffmpeg -v error -y -f lavfi -i "sine=frequency=440:sample_rate=48000" -t 90 -c:a libopus -b:a 96k -frag_duration 5000000 $FLAGS media/a96.m4s
[ -f media/hevc_hev1.m4s ] || ffmpeg -v error -y -f lavfi -i "$SRC360" -t 10 -c:v libx265 -preset ultrafast -x265-params "log-level=error:keyint=50:min-keyint=50" -tag:v hev1 -an $FLAGS media/hevc_hev1.m4s
if [ ! -f certs/key.pem ]; then
  cat > certs/openssl.cnf <<'CNF'
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = btr-ios mock
[v3]
subjectAltName = @alt
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
[alt]
DNS.1 = *.bilibili.com
DNS.2 = *.bilivideo.com
DNS.3 = *.akamaized.net
DNS.4 = b23.tv
DNS.5 = localhost
DNS.6 = *.hdslb.com
DNS.7 = *.bilivideo.cn
CNF
  openssl req -x509 -newkey rsa:2048 -nodes -keyout certs/key.pem -out certs/cert.pem -days 3650 -config certs/openssl.cnf 2>/dev/null
fi
echo "test media and certificate are in place"
