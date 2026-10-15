// encode_test.cpp — custos_h264 の結合試験 (合成フレームをエンコードして出力を検査する)
//
// 確かめること:
//   1. エンコーダが作れる (ハードウェアならその名前)
//   2. 最初の出力がキーフレームで、SPS(7) / PPS(8) / IDR(5) を含む
//   3. 途中の IDR 要求が効く (要求後のフレームにキーフレームが出る)
//   4. 要求していない間はキーフレームが出ない (長い GOP)
//   5. 実行中のビットレート変更が成功する
#include <cstdio>
#include <cstdint>
#include <thread>
#include <vector>

#include "../include/custos_h264.h"
#include "../src/annexb.h"

namespace {

void MakeFrame(std::vector<uint8_t>& nv12, int w, int h, int n) {
    for (int y = 0; y < h; ++y)
        for (int x = 0; x < w; ++x) nv12[static_cast<size_t>(y) * w + x] = static_cast<uint8_t>((x + y + n * 4) & 0xff);
    uint8_t* uv = nv12.data() + static_cast<size_t>(w) * h;
    for (int y = 0; y < h / 2; ++y)
        for (int x = 0; x < w; x += 2) {
            uv[static_cast<size_t>(y) * w + x] = static_cast<uint8_t>(128 + ((n * 2) & 31));
            uv[static_cast<size_t>(y) * w + x + 1] = static_cast<uint8_t>(128 - ((y + n) & 31));
        }
}

struct Out {
    int index;
    bool key;
    bool sps, pps, idr;
    size_t size;
};

bool PopAll(ch264_encoder* enc, std::vector<Out>& outs, std::vector<uint8_t>& buf) {
    for (;;) {
        int size = 0, key = 0;
        int64_t ts = 0;
        int r = ch264_pop(enc, buf.data(), static_cast<int>(buf.size()), &size, &ts, &key);
        if (r == CH264_E_BUFFER_TOO_SMALL) {
            buf.resize(static_cast<size_t>(size));
            continue;
        }
        if (r < 0) {
            std::printf("pop failed: %s\n", ch264_last_error(enc));
            return false;
        }
        if (r == 0) return true;
        Out o{static_cast<int>(outs.size()), key != 0,
              ch264::HasNalType(buf.data(), size, 7), ch264::HasNalType(buf.data(), size, 8),
              ch264::HasNalType(buf.data(), size, 5), static_cast<size_t>(size)};
        outs.push_back(o);
    }
}

}  // namespace

int main() {
    const int w = 640, h = 352, fps = 30, frames = 90, requestAt = 45;
    ch264_encoder* enc = nullptr;
    if (ch264_create(w, h, fps, 2'000'000, &enc) != CH264_OK) {
        std::printf("FAIL create: %s\n", ch264_create_error());
        return 1;
    }
    std::printf("encoder: %s (hardware=%d)\n", ch264_encoder_name(enc), ch264_is_hardware(enc));

    std::vector<uint8_t> nv12(static_cast<size_t>(w) * h * 3 / 2);
    std::vector<uint8_t> buf(1 << 20);
    std::vector<Out> outs;
    int outputsBeforeRequest = -1;
    bool bitrateOk = false;
    for (int i = 0; i < frames; ++i) {
        MakeFrame(nv12, w, h, i);
        if (i == requestAt) {
            outputsBeforeRequest = static_cast<int>(outs.size());
            ch264_request_keyframe(enc);
        }
        if (i == 60) bitrateOk = ch264_set_bitrate(enc, 800'000) == CH264_OK;
        if (ch264_encode(enc, nv12.data(), static_cast<int>(nv12.size()), static_cast<int64_t>(i) * 1'000'000 / fps, 0) != CH264_OK) {
            std::printf("FAIL encode %d: %s\n", i, ch264_last_error(enc));
            return 1;
        }
        if (!PopAll(enc, outs, buf)) return 1;
        std::this_thread::sleep_for(std::chrono::milliseconds(1000 / fps));
    }
    for (int i = 0; i < 50; ++i) {   // 非同期 MFT の残りを受け取る
        if (!PopAll(enc, outs, buf)) return 1;
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }

    int keyframes = 0;
    bool keyAfterRequest = false;
    bool unexpectedKey = false;
    for (const auto& o : outs) {
        if (!o.key) continue;
        ++keyframes;
        if (o.index >= outputsBeforeRequest && o.index <= outputsBeforeRequest + 5) keyAfterRequest = true;
        else if (o.index != 0) unexpectedKey = true;
    }
    size_t total = 0;
    for (const auto& o : outs) total += o.size;
    std::printf("outputs=%zu keyframes=%d bytes=%zu first(key=%d sps=%d pps=%d idr=%d) keyAfterRequest=%d unexpectedKey=%d bitrateOk=%d\n",
                outs.size(), keyframes, total, outs.empty() ? 0 : outs[0].key, outs.empty() ? 0 : outs[0].sps,
                outs.empty() ? 0 : outs[0].pps, outs.empty() ? 0 : outs[0].idr, keyAfterRequest, unexpectedKey, bitrateOk);

    bool ok = outs.size() >= static_cast<size_t>(frames - 5) && !outs.empty() && outs[0].key && outs[0].sps && outs[0].pps &&
              outs[0].idr && keyAfterRequest && !unexpectedKey && bitrateOk;
    for (const auto& o : outs) {
        if (o.key && !(o.sps && o.pps && o.idr)) ok = false;   // キーフレームは必ず SPS/PPS/IDR を持つ
    }
    ch264_destroy(enc);
    std::printf(ok ? "PASS\n" : "FAIL\n");
    return ok ? 0 : 1;
}
