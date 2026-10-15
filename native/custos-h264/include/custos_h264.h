// custos_h264.h — Custos ブリッジ用のハードウェア H.264 エンコーダ (Windows Media Foundation)
//
// Unity ブリッジ (C#) から P/Invoke で呼ぶ。NV12 のフレームを渡すと、H.264 Annex-B
// (start code 付き、キーフレームには SPS/PPS を必ず含める) のアクセスユニットを返す。
// 設計: spec/feature/webrtc-efficiency.md §7 (Unity 側エンコード)。
//
// スレッド: 1 つのハンドルの関数は同じスレッドから呼ぶか、呼び出し側で直列化すること
// (内部でも mutex で守るが、encode と pop の順序は呼び出し側が決める)。
#pragma once

#include <stdint.h>

#ifdef _WIN32
#define CH264_API extern "C" __declspec(dllexport)
#else
#define CH264_API extern "C"
#endif

typedef struct ch264_encoder ch264_encoder;

/** 戻り値: 0 = 成功、負 = 失敗 (詳細は ch264_last_error)。 */
enum {
    CH264_OK = 0,
    CH264_E_ARGS = -1,
    CH264_E_NO_ENCODER = -2,
    CH264_E_MF = -3,
    CH264_E_D3D = -4,
    CH264_E_BUFFER_TOO_SMALL = -5,
};

/**
 * エンコーダを作る。width / height は 16 の倍数、fps は 1〜120、bitrate は bps。
 * ハードウェアエンコーダを優先し、無ければソフトウェア (Microsoft H.264 Encoder) を使う。
 * 失敗時は *out = NULL で、理由は ch264_create_error で取れる。
 */
CH264_API int ch264_create(int width, int height, int fps, int bitrate_bps, ch264_encoder** out);

/** ch264_create が失敗したときの理由 (UTF-8、スレッドローカル)。 */
CH264_API const char* ch264_create_error(void);

/**
 * NV12 (Y 面 width*height、続いて UV 面 width*height/2、詰めて並べる) を 1 枚渡す。
 * timestamp_us はフレームの時刻 (マイクロ秒、単調増加)。force_keyframe != 0 で IDR にする。
 */
CH264_API int ch264_encode(ch264_encoder* enc, const uint8_t* nv12, int size, int64_t timestamp_us, int force_keyframe);

/**
 * できあがったアクセスユニットを 1 つ取り出す。
 * 戻り値: 1 = 取り出した、0 = まだ無い、CH264_E_BUFFER_TOO_SMALL = buf が足りない (*out_size に必要量)、負 = 失敗。
 */
CH264_API int ch264_pop(ch264_encoder* enc, uint8_t* buf, int capacity, int* out_size, int64_t* out_timestamp_us, int* out_keyframe);

/** 実行中にビットレートを変える (bps)。次のフレームから効く。 */
CH264_API int ch264_set_bitrate(ch264_encoder* enc, int bitrate_bps);

/** 次のフレームを IDR にする (ブラウザの PLI / 途中参加)。 */
CH264_API int ch264_request_keyframe(ch264_encoder* enc);

/** 使っているエンコーダの名前 (例 "NVIDIA H.264 Encoder MFT")、ハードウェアかどうか。 */
CH264_API const char* ch264_encoder_name(ch264_encoder* enc);
CH264_API int ch264_is_hardware(ch264_encoder* enc);

/** 直近の失敗の理由 (UTF-8)。 */
CH264_API const char* ch264_last_error(ch264_encoder* enc);

CH264_API void ch264_destroy(ch264_encoder* enc);
