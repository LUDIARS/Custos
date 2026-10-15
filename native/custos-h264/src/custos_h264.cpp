// custos_h264.cpp — C API (P/Invoke の入口)。中身は MfH264Encoder。
#include "custos_h264.h"

#include <objbase.h>
#include <cstring>
#include <string>

#include "mf_h264_encoder.h"

struct ch264_encoder {
    ch264::MfH264Encoder impl;
};

namespace {
thread_local std::string g_createError;
}

CH264_API int ch264_create(int width, int height, int fps, int bitrate_bps, ch264_encoder** out) {
    if (!out) return CH264_E_ARGS;
    *out = nullptr;
    if (width <= 0 || height <= 0 || width % 16 != 0 || height % 16 != 0 || fps < 1 || fps > 120 || bitrate_bps <= 0) {
        g_createError = "width/height must be positive multiples of 16, fps 1-120, bitrate > 0";
        return CH264_E_ARGS;
    }
    // MFT の列挙・生成には COM が要る。既に別のモデルで初期化済みなら、そのまま使う。
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    auto* enc = new ch264_encoder();
    std::string error;
    if (!enc->impl.Initialize(width, height, fps, bitrate_bps, &error)) {
        g_createError = error;
        delete enc;
        return CH264_E_NO_ENCODER;
    }
    g_createError.clear();
    *out = enc;
    return CH264_OK;
}

CH264_API const char* ch264_create_error(void) {
    return g_createError.c_str();
}

CH264_API int ch264_encode(ch264_encoder* enc, const uint8_t* nv12, int size, int64_t timestamp_us, int force_keyframe) {
    if (!enc || !nv12 || size <= 0) return CH264_E_ARGS;
    return enc->impl.Encode(nv12, timestamp_us, force_keyframe != 0) ? CH264_OK : CH264_E_MF;
}

CH264_API int ch264_pop(ch264_encoder* enc, uint8_t* buf, int capacity, int* out_size, int64_t* out_timestamp_us, int* out_keyframe) {
    if (!enc || !out_size) return CH264_E_ARGS;
    // 足りないバッファで呼ばれたら、取り出したフレームを捨てずに次の呼び出しまで持つ。
    thread_local ch264::EncodedFrame held;
    thread_local ch264_encoder* heldOwner = nullptr;
    if (heldOwner != enc) {
        if (!enc->impl.Pop(&held)) return 0;
        heldOwner = enc;
    }
    *out_size = static_cast<int>(held.data.size());
    if (!buf || capacity < static_cast<int>(held.data.size())) return CH264_E_BUFFER_TOO_SMALL;
    std::memcpy(buf, held.data.data(), held.data.size());
    if (out_timestamp_us) *out_timestamp_us = held.timestampUs;
    if (out_keyframe) *out_keyframe = held.keyframe ? 1 : 0;
    heldOwner = nullptr;
    return 1;
}

CH264_API int ch264_set_bitrate(ch264_encoder* enc, int bitrate_bps) {
    if (!enc || bitrate_bps <= 0) return CH264_E_ARGS;
    return enc->impl.SetBitrate(bitrate_bps) ? CH264_OK : CH264_E_MF;
}

CH264_API int ch264_request_keyframe(ch264_encoder* enc) {
    if (!enc) return CH264_E_ARGS;
    enc->impl.RequestKeyframe();
    return CH264_OK;
}

CH264_API const char* ch264_encoder_name(ch264_encoder* enc) {
    return enc ? enc->impl.Name().c_str() : "";
}

CH264_API int ch264_is_hardware(ch264_encoder* enc) {
    return enc && enc->impl.IsHardware() ? 1 : 0;
}

CH264_API const char* ch264_last_error(ch264_encoder* enc) {
    return enc ? enc->impl.LastError().c_str() : "";
}

CH264_API void ch264_destroy(ch264_encoder* enc) {
    delete enc;
}
