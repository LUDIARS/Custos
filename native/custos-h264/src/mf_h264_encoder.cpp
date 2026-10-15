#include <initguid.h>
#include "mf_h264_encoder.h"

#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <cstdio>
#include <cstring>

#include "annexb.h"

using Microsoft::WRL::ComPtr;

namespace ch264 {

namespace {

constexpr size_t kMaxQueuedOutput = 8;   // 取り出されない出力は古いものから捨てる

std::string WideToUtf8(const wchar_t* s) {
    if (!s) return {};
    int n = WideCharToMultiByte(CP_UTF8, 0, s, -1, nullptr, 0, nullptr, nullptr);
    std::string out(n > 0 ? n - 1 : 0, '\0');
    if (n > 1) WideCharToMultiByte(CP_UTF8, 0, s, -1, out.data(), n, nullptr, nullptr);
    return out;
}

HRESULT SetUInt32(ICodecAPI* api, const GUID& key, UINT32 value) {
    VARIANT v;
    VariantInit(&v);
    v.vt = VT_UI4;
    v.ulVal = value;
    return api->SetValue(&key, &v);
}

HRESULT SetBool(ICodecAPI* api, const GUID& key, bool value) {
    VARIANT v;
    VariantInit(&v);
    v.vt = VT_BOOL;
    v.boolVal = value ? VARIANT_TRUE : VARIANT_FALSE;
    return api->SetValue(&key, &v);
}

}  // namespace

MfH264Encoder::~MfH264Encoder() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (mft_ && started_) {
        mft_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
        mft_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
    }
    if (mft_ && useD3D_) mft_->ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, 0);
    events_.Reset();
    codec_.Reset();
    mft_.Reset();
    deviceManager_.Reset();
    uploader_.reset();
    if (mfStarted_) MFShutdown();
}

void MfH264Encoder::Fail(const char* what, HRESULT hr) {
    char buf[160];
    std::snprintf(buf, sizeof(buf), "%s (hr=0x%08lx)", what, static_cast<unsigned long>(hr));
    lastError_ = buf;
}

bool MfH264Encoder::Initialize(int width, int height, int fps, int bitrateBps, std::string* error) {
    std::lock_guard<std::mutex> lock(mutex_);
    width_ = width;
    height_ = height;
    fps_ = fps;
    frameDuration100ns_ = 10'000'000LL / fps;

    HRESULT hr = MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET);
    if (FAILED(hr)) {
        *error = "MFStartup failed";
        return false;
    }
    mfStarted_ = true;

    std::string hwError;
    if (!CreateTransform(true, &hwError)) {
        std::string swError;
        if (!CreateTransform(false, &swError)) {
            *error = "no H.264 encoder: hardware=" + hwError + " / software=" + swError;
            return false;
        }
    }

    // ハードウェア MFT には D3D11 デバイスを渡し、入力を GPU のサーフェスにする。
    if (hardware_) {
        uploader_ = std::make_unique<D3DNv12Uploader>();
        std::string d3dError;
        if (uploader_->Initialize(hasAdapterLuid_ ? &adapterLuid_ : nullptr, width, height, &d3dError)) {
            UINT token = 0;
            if (SUCCEEDED(MFCreateDXGIDeviceManager(&token, &deviceManager_)) &&
                SUCCEEDED(deviceManager_->ResetDevice(uploader_->Device(), token)) &&
                SUCCEEDED(mft_->ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER,
                                               reinterpret_cast<ULONG_PTR>(deviceManager_.Get())))) {
                useD3D_ = true;
            }
        }
        if (!useD3D_) {
            uploader_.reset();
            deviceManager_.Reset();
        }
    }

    ConfigureCodec();
    if (codec_) SetUInt32(codec_.Get(), CODECAPI_AVEncCommonMeanBitRate, static_cast<UINT32>(bitrateBps));
    if (!SetMediaTypes(error)) return false;

    hr = mft_->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
    if (SUCCEEDED(hr)) hr = mft_->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);
    if (FAILED(hr)) {
        *error = "begin streaming failed";
        return false;
    }
    started_ = true;
    return true;
}

bool MfH264Encoder::CreateTransform(bool hardware, std::string* error) {
    MFT_REGISTER_TYPE_INFO input{MFMediaType_Video, MFVideoFormat_NV12};
    MFT_REGISTER_TYPE_INFO output{MFMediaType_Video, MFVideoFormat_H264};
    UINT32 flags = MFT_ENUM_FLAG_SORTANDFILTER | (hardware ? MFT_ENUM_FLAG_HARDWARE : MFT_ENUM_FLAG_SYNCMFT);
    IMFActivate** activates = nullptr;
    UINT32 count = 0;
    HRESULT hr = MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, flags, &input, &output, &activates, &count);
    if (FAILED(hr) || count == 0) {
        if (activates) CoTaskMemFree(activates);
        *error = "not found";
        return false;
    }
    bool ok = false;
    for (UINT32 i = 0; i < count && !ok; ++i) {
        ComPtr<IMFTransform> mft;
        if (FAILED(activates[i]->ActivateObject(IID_PPV_ARGS(&mft)))) continue;
        wchar_t* friendly = nullptr;
        UINT32 len = 0;
        if (SUCCEEDED(activates[i]->GetAllocatedString(MFT_FRIENDLY_NAME_Attribute, &friendly, &len))) {
            name_ = WideToUtf8(friendly);
            CoTaskMemFree(friendly);
        }
        UINT32 luidSize = 0;
        hasAdapterLuid_ = SUCCEEDED(activates[i]->GetBlob(MFT_ENUM_ADAPTER_LUID, reinterpret_cast<UINT8*>(&adapterLuid_),
                                                          sizeof(adapterLuid_), &luidSize)) && luidSize == sizeof(adapterLuid_);
        ComPtr<IMFAttributes> attrs;
        if (SUCCEEDED(mft->GetAttributes(&attrs)) && attrs) {
            UINT32 isAsync = 0;
            async_ = SUCCEEDED(attrs->GetUINT32(MF_TRANSFORM_ASYNC, &isAsync)) && isAsync;
            if (async_) attrs->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, TRUE);
            attrs->SetUINT32(MF_LOW_LATENCY, TRUE);
        } else {
            async_ = false;
        }
        if (async_ && FAILED(mft.As(&events_))) continue;
        mft_ = mft;
        hardware_ = hardware;
        ok = true;
    }
    for (UINT32 i = 0; i < count; ++i) activates[i]->Release();
    CoTaskMemFree(activates);
    if (!ok) *error = "activate failed";
    return ok;
}

bool MfH264Encoder::ConfigureCodec() {
    if (FAILED(mft_.As(&codec_))) {
        codec_.Reset();
        return false;
    }
    // 失敗しても致命ではない (MFT によって未対応のキーがある)。既定値で動かす。
    SetBool(codec_.Get(), CODECAPI_AVLowLatencyMode, true);
    SetUInt32(codec_.Get(), CODECAPI_AVEncCommonRateControlMode, eAVEncCommonRateControlMode_CBR);
    SetUInt32(codec_.Get(), CODECAPI_AVEncMPVDefaultBPictureCount, 0);
    // IDR は要求時だけ出すので GOP は長く (10 秒)。損失からは PLI → ForceKeyFrame で戻す。
    SetUInt32(codec_.Get(), CODECAPI_AVEncMPVGOPSize, static_cast<UINT32>(fps_ * 10));
    return true;
}

bool MfH264Encoder::SetMediaTypes(std::string* error) {
    ComPtr<IMFMediaType> out;
    MFCreateMediaType(&out);
    out->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    out->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
    UINT32 bitrate = 0;
    if (codec_) {
        VARIANT v;
        VariantInit(&v);
        if (SUCCEEDED(codec_->GetValue(&CODECAPI_AVEncCommonMeanBitRate, &v)) && v.vt == VT_UI4) bitrate = v.ulVal;
    }
    out->SetUINT32(MF_MT_AVG_BITRATE, bitrate ? bitrate : 3'000'000);
    MFSetAttributeSize(out.Get(), MF_MT_FRAME_SIZE, width_, height_);
    MFSetAttributeRatio(out.Get(), MF_MT_FRAME_RATE, fps_, 1);
    MFSetAttributeRatio(out.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
    out->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    // ブラウザと合わせた codec 契約 (profile-level-id=42e01f) に合わせて baseline / level 3.1。
    out->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Base);
    out->SetUINT32(MF_MT_MPEG2_LEVEL, (width_ * height_ > 1280 * 720) ? eAVEncH264VLevel4_1 : eAVEncH264VLevel3_1);
    HRESULT hr = mft_->SetOutputType(0, out.Get(), 0);
    if (FAILED(hr)) {
        Fail("SetOutputType", hr);
        *error = lastError_;
        return false;
    }

    ComPtr<IMFMediaType> in;
    MFCreateMediaType(&in);
    in->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    in->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
    MFSetAttributeSize(in.Get(), MF_MT_FRAME_SIZE, width_, height_);
    MFSetAttributeRatio(in.Get(), MF_MT_FRAME_RATE, fps_, 1);
    MFSetAttributeRatio(in.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
    in->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    hr = mft_->SetInputType(0, in.Get(), 0);
    if (FAILED(hr)) {
        Fail("SetInputType", hr);
        *error = lastError_;
        return false;
    }
    return true;
}

bool MfH264Encoder::Encode(const uint8_t* nv12, int64_t timestampUs, bool forceKeyframe) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!started_) return false;
    const bool key = forceKeyframe || keyRequested_;
    keyRequested_ = false;
    if (!async_) return SubmitInput(nv12, timestampUs, key) && DrainOutput();

    if (!PumpEvents()) return false;
    if (needInput_ > 0) {
        --needInput_;
        if (!SubmitInput(nv12, timestampUs, key)) return false;
        return PumpEvents();
    }
    // まだ入力を受け付けない: 最新 1 枚だけ持つ (キーフレーム要求は引き継ぐ)。
    const size_t size = static_cast<size_t>(width_) * height_ * 3 / 2;
    pending_.assign(nv12, nv12 + size);
    pendingTs_ = timestampUs;
    pendingKey_ = pendingKey_ || key;
    hasPending_ = true;
    return true;
}

bool MfH264Encoder::Pop(EncodedFrame* frame) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (async_) {
        PumpEvents();
        FeedPending();
    }
    if (output_.empty()) return false;
    *frame = std::move(output_.front());
    output_.pop_front();
    return true;
}

bool MfH264Encoder::SetBitrate(int bitrateBps) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!codec_) return false;
    HRESULT hr = SetUInt32(codec_.Get(), CODECAPI_AVEncCommonMeanBitRate, static_cast<UINT32>(bitrateBps));
    if (FAILED(hr)) Fail("set bitrate", hr);
    return SUCCEEDED(hr);
}

void MfH264Encoder::RequestKeyframe() {
    std::lock_guard<std::mutex> lock(mutex_);
    keyRequested_ = true;
}

bool MfH264Encoder::PumpEvents() {
    if (!events_) return true;
    for (;;) {
        ComPtr<IMFMediaEvent> ev;
        HRESULT hr = events_->GetEvent(MF_EVENT_FLAG_NO_WAIT, &ev);
        if (hr == MF_E_NO_EVENTS_AVAILABLE) return true;
        if (FAILED(hr)) {
            Fail("GetEvent", hr);
            return false;
        }
        MediaEventType type = MEUnknown;
        ev->GetType(&type);
        if (type == METransformNeedInput) {
            ++needInput_;
        } else if (type == METransformHaveOutput) {
            bool got = false;
            if (!ProcessOneOutput(&got)) return false;
        }
    }
}

bool MfH264Encoder::FeedPending() {
    if (!hasPending_ || needInput_ <= 0) return true;
    --needInput_;
    hasPending_ = false;
    const bool key = pendingKey_;
    pendingKey_ = false;
    return SubmitInput(pending_.data(), pendingTs_, key);
}

bool MfH264Encoder::SubmitInput(const uint8_t* nv12, int64_t timestampUs, bool forceKeyframe) {
    if (forceKeyframe && codec_) SetUInt32(codec_.Get(), CODECAPI_AVEncVideoForceKeyFrame, 1);

    const int64_t time100ns = timestampUs * 10;
    ComPtr<IMFSample> sample;
    HRESULT hr = E_FAIL;
    if (useD3D_) {
        hr = uploader_->CreateSample(nv12, time100ns, frameDuration100ns_, &sample);
    } else {
        const DWORD size = static_cast<DWORD>(width_) * height_ * 3 / 2;
        ComPtr<IMFMediaBuffer> buffer;
        hr = MFCreateMemoryBuffer(size, &buffer);
        BYTE* dst = nullptr;
        if (SUCCEEDED(hr)) hr = buffer->Lock(&dst, nullptr, nullptr);
        if (SUCCEEDED(hr)) {
            std::memcpy(dst, nv12, size);
            buffer->Unlock();
            buffer->SetCurrentLength(size);
            hr = MFCreateSample(&sample);
        }
        if (SUCCEEDED(hr)) {
            sample->AddBuffer(buffer.Get());
            sample->SetSampleTime(time100ns);
            sample->SetSampleDuration(frameDuration100ns_);
        }
    }
    if (FAILED(hr)) {
        Fail("create input sample", hr);
        return false;
    }
    hr = mft_->ProcessInput(0, sample.Get(), 0);
    if (FAILED(hr) && hr != MF_E_NOTACCEPTING) {
        Fail("ProcessInput", hr);
        return false;
    }
    return true;
}

bool MfH264Encoder::DrainOutput() {
    for (;;) {
        bool got = false;
        if (!ProcessOneOutput(&got)) return false;
        if (!got) return true;
    }
}

bool MfH264Encoder::ProcessOneOutput(bool* gotOutput) {
    *gotOutput = false;
    MFT_OUTPUT_STREAM_INFO info{};
    HRESULT hr = mft_->GetOutputStreamInfo(0, &info);
    if (FAILED(hr)) {
        Fail("GetOutputStreamInfo", hr);
        return false;
    }
    const bool mftAllocates = (info.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES)) != 0;
    ComPtr<IMFSample> ownSample;
    if (!mftAllocates) {
        ComPtr<IMFMediaBuffer> buffer;
        const DWORD size = info.cbSize ? info.cbSize : static_cast<DWORD>(width_) * height_ * 2;
        if (FAILED(MFCreateMemoryBuffer(size, &buffer)) || FAILED(MFCreateSample(&ownSample))) {
            Fail("allocate output sample", E_OUTOFMEMORY);
            return false;
        }
        ownSample->AddBuffer(buffer.Get());
    }
    MFT_OUTPUT_DATA_BUFFER out{};
    out.dwStreamID = 0;
    out.pSample = ownSample.Get();
    DWORD status = 0;
    hr = mft_->ProcessOutput(0, 1, &out, &status);
    if (out.pEvents) out.pEvents->Release();
    if (hr == MF_E_TRANSFORM_NEED_MORE_INPUT) return true;
    if (hr == MF_E_TRANSFORM_STREAM_CHANGE) {
        // 出力形式が確定し直した: 提示された型を受け入れて続ける。
        ComPtr<IMFMediaType> type;
        if (SUCCEEDED(mft_->GetOutputAvailableType(0, 0, &type))) mft_->SetOutputType(0, type.Get(), 0);
        return true;
    }
    if (FAILED(hr)) {
        if (mftAllocates && out.pSample) out.pSample->Release();
        Fail("ProcessOutput", hr);
        return false;
    }
    ComPtr<IMFSample> sample;
    if (mftAllocates) sample.Attach(out.pSample);
    else sample = ownSample;
    if (!sample) return true;

    ComPtr<IMFMediaBuffer> buffer;
    if (FAILED(sample->ConvertToContiguousBuffer(&buffer))) return true;
    BYTE* data = nullptr;
    DWORD length = 0;
    if (FAILED(buffer->Lock(&data, nullptr, &length))) return true;

    EncodedFrame frame;
    UINT32 clean = 0;
    frame.keyframe = (SUCCEEDED(sample->GetUINT32(MFSampleExtension_CleanPoint, &clean)) && clean) || HasNalType(data, length, 5);
    LONGLONG t = 0;
    if (SUCCEEDED(sample->GetSampleTime(&t))) frame.timestampUs = t / 10;
    if (frame.keyframe) {
        // SPS/PPS を覚えておき、無いキーフレームには付ける (ブラウザが途中から復号できるように)。
        std::vector<uint8_t> sets = ExtractParameterSets(data, length);
        if (!sets.empty()) parameterSets_ = std::move(sets);
        if (parameterSets_.empty()) {
            ComPtr<IMFMediaType> type;
            UINT32 headerSize = 0;
            if (SUCCEEDED(mft_->GetOutputCurrentType(0, &type)) &&
                SUCCEEDED(type->GetBlobSize(MF_MT_MPEG_SEQUENCE_HEADER, &headerSize)) && headerSize > 0) {
                std::vector<uint8_t> header(headerSize);
                if (SUCCEEDED(type->GetBlob(MF_MT_MPEG_SEQUENCE_HEADER, header.data(), headerSize, nullptr))) {
                    parameterSets_ = ExtractParameterSets(header.data(), header.size());
                }
            }
        }
        frame.data = EnsureParameterSets(data, length, parameterSets_);
    } else {
        frame.data.assign(data, data + length);
    }
    buffer->Unlock();

    if (output_.size() >= kMaxQueuedOutput) {
        // 取り出しが追いつかない: 古いものを捨てる。差分フレームが欠けると崩れるので次を IDR にする。
        output_.pop_front();
        keyRequested_ = true;
    }
    output_.push_back(std::move(frame));
    *gotOutput = true;
    return true;
}

}  // namespace ch264
