// d3d_nv12_uploader.h — NV12 のフレームを D3D11 テクスチャに載せ、MF のサンプルにする
//
// ハードウェアエンコーダ (MFT) は D3D11 のサーフェスを入力に取るのが確実なので、プラグインが
// 自分の D3D11 デバイス (エンコーダと同じアダプタ) を持ち、NV12 をステージングテクスチャ経由で
// GPU に載せる。非同期の MFT は入力テクスチャを処理し終えるまで保持するので、数枚を巡回して使う。
#pragma once

#include <d3d11.h>
#include <mfidl.h>
#include <wrl/client.h>
#include <cstdint>
#include <string>
#include <vector>

namespace ch264 {

class D3DNv12Uploader {
public:
    /** adapterLuid が null なら既定のアダプタ。失敗したら false (理由は error)。 */
    bool Initialize(const LUID* adapterLuid, int width, int height, std::string* error);

    ID3D11Device* Device() const { return device_.Get(); }

    /** NV12 (詰めて並べた Y 面 + UV 面) を次のテクスチャに書き、それを包んだ MF サンプルを返す。 */
    HRESULT CreateSample(const uint8_t* nv12, int64_t time100ns, int64_t duration100ns, IMFSample** sample);

private:
    static constexpr int kRingSize = 4;

    Microsoft::WRL::ComPtr<ID3D11Device> device_;
    Microsoft::WRL::ComPtr<ID3D11DeviceContext> context_;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> staging_;
    std::vector<Microsoft::WRL::ComPtr<ID3D11Texture2D>> ring_;
    int next_ = 0;
    int width_ = 0;
    int height_ = 0;
};

}  // namespace ch264
