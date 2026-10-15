#include "d3d_nv12_uploader.h"

#include <d3d10.h>
#include <dxgi1_2.h>
#include <mfapi.h>
#include <cstring>

using Microsoft::WRL::ComPtr;

namespace ch264 {

namespace {

ComPtr<IDXGIAdapter1> FindAdapter(const LUID* luid) {
    if (!luid) return nullptr;
    ComPtr<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) return nullptr;
    ComPtr<IDXGIAdapter1> adapter;
    for (UINT i = 0; factory->EnumAdapters1(i, &adapter) != DXGI_ERROR_NOT_FOUND; ++i) {
        DXGI_ADAPTER_DESC1 desc{};
        if (SUCCEEDED(adapter->GetDesc1(&desc)) &&
            desc.AdapterLuid.LowPart == luid->LowPart && desc.AdapterLuid.HighPart == luid->HighPart) {
            return adapter;
        }
        adapter.Reset();
    }
    return nullptr;
}

}  // namespace

bool D3DNv12Uploader::Initialize(const LUID* adapterLuid, int width, int height, std::string* error) {
    width_ = width;
    height_ = height;
    ComPtr<IDXGIAdapter1> adapter = FindAdapter(adapterLuid);
    const UINT flags = D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT;
    static const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
    HRESULT hr = D3D11CreateDevice(adapter.Get(), adapter ? D3D_DRIVER_TYPE_UNKNOWN : D3D_DRIVER_TYPE_HARDWARE,
                                   nullptr, flags, levels, 2, D3D11_SDK_VERSION, &device_, nullptr, &context_);
    if (FAILED(hr)) {
        *error = "D3D11CreateDevice failed";
        return false;
    }
    // MF のスレッドとこちらのスレッドが同じデバイスを触るので、デバイスを直列化する。
    ComPtr<ID3D10Multithread> mt;
    if (SUCCEEDED(device_.As(&mt))) mt->SetMultithreadProtected(TRUE);

    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = static_cast<UINT>(width);
    desc.Height = static_cast<UINT>(height);
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_NV12;
    desc.SampleDesc.Count = 1;

    desc.Usage = D3D11_USAGE_STAGING;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
    if (FAILED(device_->CreateTexture2D(&desc, nullptr, &staging_))) {
        *error = "NV12 staging texture is not supported";
        return false;
    }

    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.CPUAccessFlags = 0;
    // エンコーダがどの bind を要るかはドライバ次第なので、広い順に試す。
    static const UINT bindCandidates[] = {
        D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE, D3D11_BIND_SHADER_RESOURCE, 0};
    for (UINT bind : bindCandidates) {
        desc.BindFlags = bind;
        ring_.clear();
        bool ok = true;
        for (int i = 0; i < kRingSize && ok; ++i) {
            ComPtr<ID3D11Texture2D> tex;
            ok = SUCCEEDED(device_->CreateTexture2D(&desc, nullptr, &tex));
            if (ok) ring_.push_back(tex);
        }
        if (ok) return true;
    }
    *error = "NV12 texture is not supported";
    return false;
}

HRESULT D3DNv12Uploader::CreateSample(const uint8_t* nv12, int64_t time100ns, int64_t duration100ns, IMFSample** sample) {
    D3D11_MAPPED_SUBRESOURCE mapped{};
    HRESULT hr = context_->Map(staging_.Get(), 0, D3D11_MAP_WRITE, 0, &mapped);
    if (FAILED(hr)) return hr;
    auto* dst = static_cast<uint8_t*>(mapped.pData);
    // NV12 の対応付け: Y 面の後ろ (RowPitch * Height) に UV 面が続く。
    for (int y = 0; y < height_; ++y) {
        std::memcpy(dst + static_cast<size_t>(y) * mapped.RowPitch, nv12 + static_cast<size_t>(y) * width_, width_);
    }
    const uint8_t* uvSrc = nv12 + static_cast<size_t>(width_) * height_;
    uint8_t* uvDst = dst + static_cast<size_t>(mapped.RowPitch) * height_;
    for (int y = 0; y < height_ / 2; ++y) {
        std::memcpy(uvDst + static_cast<size_t>(y) * mapped.RowPitch, uvSrc + static_cast<size_t>(y) * width_, width_);
    }
    context_->Unmap(staging_.Get(), 0);

    ID3D11Texture2D* target = ring_[next_].Get();
    next_ = (next_ + 1) % static_cast<int>(ring_.size());
    context_->CopyResource(target, staging_.Get());

    ComPtr<IMFMediaBuffer> buffer;
    hr = MFCreateDXGISurfaceBuffer(__uuidof(ID3D11Texture2D), target, 0, FALSE, &buffer);
    if (FAILED(hr)) return hr;
    ComPtr<IMF2DBuffer> buffer2d;
    if (SUCCEEDED(buffer.As(&buffer2d))) {
        DWORD length = 0;
        if (SUCCEEDED(buffer2d->GetContiguousLength(&length))) buffer->SetCurrentLength(length);
    }
    ComPtr<IMFSample> s;
    hr = MFCreateSample(&s);
    if (FAILED(hr)) return hr;
    s->AddBuffer(buffer.Get());
    s->SetSampleTime(time100ns);
    s->SetSampleDuration(duration100ns);
    *sample = s.Detach();
    return S_OK;
}

}  // namespace ch264
