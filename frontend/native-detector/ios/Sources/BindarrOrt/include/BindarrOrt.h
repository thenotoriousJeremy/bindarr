// The few ONNX Runtime calls the iOS detector makes, over ORT's C API.
//
// Microsoft's Swift package (and the Objective-C wrapper it carried) left GitHub
// in November 2026, so the plugin links the plain onnxruntime.xcframework from
// Microsoft's NuGet package (see Package.swift) and calls it through this shim
// instead of ORTSession and friends. Everything runs on the plugin's one serial
// queue; nothing here is thread-safe on its own.
//
// Errors: a function that can fail returns 0 on success, or -1 with a message
// written to `err` (always NUL-terminated, cut to `errLen`).
#ifndef BINDARR_ORT_H
#define BINDARR_ORT_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct BindarrOrtSession BindarrOrtSession;

// 1 when this ORT build has the CoreML execution provider.
int bindarr_ort_coreml_available(void);

// A session from the model's bytes. `useCoreML` adds the CoreML EP (as an
// MLProgram); the CPU EP takes whatever it cannot. `threads` is the intra-op
// thread count. Returns NULL on failure.
BindarrOrtSession *bindarr_ort_create(const void *model, size_t modelLen, int useCoreML, int threads,
                                      char *err, size_t errLen);

void bindarr_ort_release(BindarrOrtSession *session);

// The model's output names, owned by the session.
size_t bindarr_ort_output_count(const BindarrOrtSession *session);
const char *bindarr_ort_output_name(const BindarrOrtSession *session, size_t index);

// One run with a single float input. Each requested output comes back as a
// malloc'd float array in outData[i] with its element count in outLens[i]; free
// each with bindarr_ort_free. On failure nothing is left allocated.
int bindarr_ort_run(BindarrOrtSession *session, const char *inputName, const float *input,
                    const int64_t *shape, size_t rank, const char *const *outNames, size_t outCount,
                    float **outData, size_t *outLens, char *err, size_t errLen);

void bindarr_ort_free(float *data);

#ifdef __cplusplus
}
#endif

#endif
