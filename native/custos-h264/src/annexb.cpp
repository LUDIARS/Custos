#include "annexb.h"

namespace ch264 {

namespace {

// pos から次の start code を探す。見つかったら start code の先頭位置と長さ (3 or 4) を返す。
bool FindStartCode(const uint8_t* data, size_t size, size_t pos, size_t* at, size_t* len) {
    for (size_t i = pos; i + 3 <= size; ++i) {
        if (data[i] != 0 || data[i + 1] != 0) continue;
        if (data[i + 2] == 1) {
            *at = i;
            *len = 3;
            return true;
        }
        if (i + 4 <= size && data[i + 2] == 0 && data[i + 3] == 1) {
            *at = i;
            *len = 4;
            return true;
        }
    }
    return false;
}

void AppendNal(std::vector<uint8_t>& out, const uint8_t* nal, size_t size) {
    static const uint8_t kStart[4] = {0, 0, 0, 1};
    out.insert(out.end(), kStart, kStart + 4);
    out.insert(out.end(), nal, nal + size);
}

}  // namespace

std::vector<NalUnit> SplitNals(const uint8_t* data, size_t size) {
    std::vector<NalUnit> nals;
    size_t at = 0, len = 0;
    if (!data || !FindStartCode(data, size, 0, &at, &len)) return nals;
    size_t begin = at + len;
    while (begin < size) {
        size_t next = size, nextLen = 0;
        size_t found = 0;
        if (FindStartCode(data, size, begin, &found, &nextLen)) next = found;
        // 末尾の 0 (trailing_zero) は NAL に含めない。
        size_t end = next;
        while (end > begin && data[end - 1] == 0 && next != size) --end;
        if (end > begin) nals.push_back({begin, end - begin, static_cast<uint8_t>(data[begin] & 0x1f)});
        if (next == size) break;
        begin = next + nextLen;
    }
    return nals;
}

bool HasNalType(const uint8_t* data, size_t size, uint8_t type) {
    for (const auto& nal : SplitNals(data, size)) {
        if (nal.type == type) return true;
    }
    return false;
}

std::vector<uint8_t> EnsureParameterSets(const uint8_t* data, size_t size, const std::vector<uint8_t>& sequenceHeader) {
    std::vector<uint8_t> out;
    if (HasNalType(data, size, 7) && HasNalType(data, size, 8)) {
        out.assign(data, data + size);
        return out;
    }
    out.reserve(sequenceHeader.size() + size);
    out.insert(out.end(), sequenceHeader.begin(), sequenceHeader.end());
    out.insert(out.end(), data, data + size);
    return out;
}

std::vector<uint8_t> ExtractParameterSets(const uint8_t* data, size_t size) {
    std::vector<uint8_t> out;
    bool sps = false, pps = false;
    for (const auto& nal : SplitNals(data, size)) {
        if (nal.type == 7 || nal.type == 8) {
            AppendNal(out, data + nal.offset, nal.size);
            sps = sps || nal.type == 7;
            pps = pps || nal.type == 8;
        }
    }
    if (!sps || !pps) out.clear();
    return out;
}

}  // namespace ch264
