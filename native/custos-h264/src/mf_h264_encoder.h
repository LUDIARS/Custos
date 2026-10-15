// mf_h264_encoder.h — Media Foundation の H.264 エンコーダ MFT を包む
//
// - ハードウェア MFT (非同期) を優先し、無ければソフトウェア MFT (同期) を使う。
// - 低遅延・B フレーム無し・baseline・長い GOP。IDR は最初と要求時 (ForceKeyFrame) だけ。
// - ビットレートは実行中に変えられる (CODECAPI_AVEncCommonMeanBitRate)。
// - 出力は Annex-B。キーフレームには SPS/PPS を必ず付ける (annexb.h)。
#pragma once

#include <mftransform.h>
#include <codecapi.h>
#include <strmif.h>
#include <wrl/client.h>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "d3d_nv12_uploader.h"

namespace ch264 {

struct EncodedFrame {
    std::vector<uint8_t> data;
    int64_t timestampUs = 0;
    bool keyframe = false;
};

class MfH264Encoder {
public:
    ~MfH264Encoder();

    bool Initialize(int width, int height, int fps, int bitrateBps, std::string* error);

    /** NV12 を 1 枚渡す。非同期 MFT がまだ入力を受け付けない間は、最新 1 枚だけ保留する。 */
    bool Encode(const uint8_t* nv12, int64_t timestampUs, bool forceKeyframe);

    /** できあがったフレームを 1 つ取り出す。無ければ false。 */
    bool Pop(EncodedFrame* frame);

    bool SetBitrate(int bitrateBps);
    void RequestKeyframe();

    const std::string& Name() const { return name_; }
    bool IsHardware() const { return hardware_; }
    const std::string& LastError() const { return lastError_; }

private:
    bool CreateTransform(bool hardware, std::string* error);
    bool ConfigureCodec();
    bool SetMediaTypes(std::string* error);
    bool PumpEvents();
    bool FeedPending();
    bool SubmitInput(const uint8_t* nv12, int64_t timestampUs, bool forceKeyframe);
    bool DrainOutput();
    bool ProcessOneOutput(bool* gotOutput);
    void Fail(const char* what, HRESULT hr);

    std::mutex mutex_;
    Microsoft::WRL::ComPtr<IMFTransform> mft_;
    Microsoft::WRL::ComPtr<ICodecAPI> codec_;
    Microsoft::WRL::ComPtr<IMFMediaEventGenerator> events_;
    Microsoft::WRL::ComPtr<IMFDXGIDeviceManager> deviceManager_;
    std::unique_ptr<D3DNv12Uploader> uploader_;
    bool useD3D_ = false;
    bool async_ = false;
    bool hardware_ = false;
    bool started_ = false;
    bool mfStarted_ = false;
    LUID adapterLuid_{};
    bool hasAdapterLuid_ = false;
    int needInput_ = 0;
    int width_ = 0, height_ = 0, fps_ = 30;
    int64_t frameDuration100ns_ = 0;
    std::string name_;
    std::string lastError_;

    // 非同期 MFT が入力を求めるまで待つ最新 1 枚 (古いものは捨てる: 遅延を積まない)。
    std::vector<uint8_t> pending_;
    int64_t pendingTs_ = 0;
    bool pendingKey_ = false;
    bool hasPending_ = false;
    bool keyRequested_ = true;   // 最初のフレームは必ず IDR

    std::deque<EncodedFrame> output_;
    std::vector<uint8_t> parameterSets_;
};

}  // namespace ch264
