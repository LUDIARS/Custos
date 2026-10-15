// annexb.h — H.264 Annex-B バイト列の NAL 解析 (純ロジック、OS 非依存)
#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace ch264 {

struct NalUnit {
    size_t offset;   // start code を除いた NAL 先頭の位置
    size_t size;     // start code を除いた NAL の長さ
    uint8_t type;    // nal_unit_type (下位 5 bit)
};

/** start code (00 00 01 / 00 00 00 01) で区切った NAL の一覧。 */
std::vector<NalUnit> SplitNals(const uint8_t* data, size_t size);

bool HasNalType(const uint8_t* data, size_t size, uint8_t type);

/**
 * キーフレームに SPS (7) / PPS (8) が無ければ、sequenceHeader (Annex-B の SPS/PPS) を前に付けたものを返す。
 * 既に両方あれば data をそのまま返す。ブラウザが途中から受けても復号できるようにするため。
 */
std::vector<uint8_t> EnsureParameterSets(const uint8_t* data, size_t size, const std::vector<uint8_t>& sequenceHeader);

/** data の中の SPS / PPS だけを Annex-B で抜き出す (キャッシュ用)。両方無ければ空。 */
std::vector<uint8_t> ExtractParameterSets(const uint8_t* data, size_t size);

}  // namespace ch264
