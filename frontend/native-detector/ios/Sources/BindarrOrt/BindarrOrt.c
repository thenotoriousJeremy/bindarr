#include "BindarrOrt.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <onnxruntime/onnxruntime_c_api.h>
#include <onnxruntime/coreml_provider_factory.h>

struct BindarrOrtSession {
  OrtSession *session;
  char **outputNames;
  size_t outputCount;
};

static const OrtApi *ort(void) {
  static const OrtApi *api = NULL;
  if (!api) api = OrtGetApiBase()->GetApi(ORT_API_VERSION);
  return api;
}

// One environment for the life of the app, like the ORTEnv the plugin kept.
static OrtEnv *env = NULL;

static void setError(char *err, size_t errLen, const char *msg) {
  if (err && errLen) snprintf(err, errLen, "%s", msg ? msg : "unknown error");
}

// Turns a failed OrtStatus into the message, releasing it. 0 means it was fine.
static int failed(OrtStatus *status, char *err, size_t errLen) {
  if (!status) return 0;
  setError(err, errLen, ort()->GetErrorMessage(status));
  ort()->ReleaseStatus(status);
  return -1;
}

int bindarr_ort_coreml_available(void) {
  const OrtApi *api = ort();
  if (!api) return 0;
  char **providers = NULL;
  int count = 0;
  OrtStatus *status = api->GetAvailableProviders(&providers, &count);
  if (status) { api->ReleaseStatus(status); return 0; }
  int found = 0;
  for (int i = 0; i < count; i++) {
    if (strcmp(providers[i], "CoreMLExecutionProvider") == 0) found = 1;
  }
  api->ReleaseAvailableProviders(providers, count);
  return found;
}

BindarrOrtSession *bindarr_ort_create(const void *model, size_t modelLen, int useCoreML, int threads,
                                      char *err, size_t errLen) {
  const OrtApi *api = ort();
  if (!api) { setError(err, errLen, "ONNX Runtime API version not supported"); return NULL; }
  if (!env && failed(api->CreateEnv(ORT_LOGGING_LEVEL_WARNING, "bindarr", &env), err, errLen)) return NULL;

  OrtSessionOptions *opts = NULL;
  if (failed(api->CreateSessionOptions(&opts), err, errLen)) return NULL;
  OrtSession *session = NULL;
  int bad = failed(api->SetSessionGraphOptimizationLevel(opts, ORT_ENABLE_ALL), err, errLen)
    || failed(api->AddSessionConfigEntry(opts, "session.intra_op.allow_spinning", "0"), err, errLen)
    || failed(api->SetIntraOpNumThreads(opts, threads), err, errLen)
    || (useCoreML && failed(OrtSessionOptionsAppendExecutionProvider_CoreML(opts, COREML_FLAG_CREATE_MLPROGRAM), err, errLen))
    || failed(api->CreateSessionFromArray(env, model, modelLen, opts, &session), err, errLen);
  api->ReleaseSessionOptions(opts);
  if (bad) return NULL;

  BindarrOrtSession *s = calloc(1, sizeof *s);
  if (!s) { api->ReleaseSession(session); setError(err, errLen, "out of memory"); return NULL; }
  s->session = session;

  OrtAllocator *alloc = NULL;
  size_t count = 0;
  if (failed(api->GetAllocatorWithDefaultOptions(&alloc), err, errLen)
      || failed(api->SessionGetOutputCount(session, &count), err, errLen)) {
    bindarr_ort_release(s);
    return NULL;
  }
  s->outputNames = calloc(count ? count : 1, sizeof(char *));
  if (!s->outputNames) { bindarr_ort_release(s); setError(err, errLen, "out of memory"); return NULL; }
  for (size_t i = 0; i < count; i++) {
    char *name = NULL;
    if (failed(api->SessionGetOutputName(session, i, alloc, &name), err, errLen)) {
      bindarr_ort_release(s);
      return NULL;
    }
    s->outputNames[i] = strdup(name);
    s->outputCount = i + 1;
    api->AllocatorFree(alloc, name);
    if (!s->outputNames[i]) { bindarr_ort_release(s); setError(err, errLen, "out of memory"); return NULL; }
  }
  return s;
}

void bindarr_ort_release(BindarrOrtSession *s) {
  if (!s) return;
  for (size_t i = 0; i < s->outputCount; i++) free(s->outputNames[i]);
  free(s->outputNames);
  if (s->session) ort()->ReleaseSession(s->session);
  free(s);
}

size_t bindarr_ort_output_count(const BindarrOrtSession *s) {
  return s ? s->outputCount : 0;
}

const char *bindarr_ort_output_name(const BindarrOrtSession *s, size_t index) {
  return s && index < s->outputCount ? s->outputNames[index] : NULL;
}

int bindarr_ort_run(BindarrOrtSession *s, const char *inputName, const float *input,
                    const int64_t *shape, size_t rank, const char *const *outNames, size_t outCount,
                    float **outData, size_t *outLens, char *err, size_t errLen) {
  const OrtApi *api = ort();
  if (!s || !s->session) { setError(err, errLen, "no session"); return -1; }
  for (size_t i = 0; i < outCount; i++) { outData[i] = NULL; outLens[i] = 0; }

  size_t elements = 1;
  for (size_t i = 0; i < rank; i++) elements *= (size_t)shape[i];

  OrtMemoryInfo *mem = NULL;
  OrtValue *in = NULL;
  OrtValue **outs = calloc(outCount ? outCount : 1, sizeof(OrtValue *));
  if (!outs) { setError(err, errLen, "out of memory"); return -1; }

  int rc = failed(api->CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault, &mem), err, errLen)
    // ORT reads the caller's buffer in place and does not write to an input.
    || failed(api->CreateTensorWithDataAsOrtValue(mem, (void *)input, elements * sizeof(float), shape, rank,
                                                  ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &in), err, errLen)
    || failed(api->Run(s->session, NULL, &inputName, (const OrtValue *const *)&in, 1, outNames, outCount, outs),
              err, errLen);

  for (size_t i = 0; rc == 0 && i < outCount; i++) {
    OrtTensorTypeAndShapeInfo *info = NULL;
    size_t n = 0;
    void *data = NULL;
    ONNXTensorElementDataType type = ONNX_TENSOR_ELEMENT_DATA_TYPE_UNDEFINED;
    if (failed(api->GetTensorTypeAndShape(outs[i], &info), err, errLen)) { rc = -1; break; }
    OrtStatus *status = api->GetTensorShapeElementCount(info, &n);
    if (!status) status = api->GetTensorElementType(info, &type);
    api->ReleaseTensorTypeAndShapeInfo(info);
    if (failed(status, err, errLen) || failed(api->GetTensorMutableData(outs[i], &data), err, errLen)) { rc = -1; break; }
    if (type != ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT) { setError(err, errLen, "output is not a float tensor"); rc = -1; break; }
    outData[i] = malloc(n ? n * sizeof(float) : 1);
    if (!outData[i]) { setError(err, errLen, "out of memory"); rc = -1; break; }
    memcpy(outData[i], data, n * sizeof(float));
    outLens[i] = n;
  }

  for (size_t i = 0; i < outCount; i++) {
    if (outs[i]) api->ReleaseValue(outs[i]);
    if (rc != 0) { free(outData[i]); outData[i] = NULL; outLens[i] = 0; }
  }
  free(outs);
  if (in) api->ReleaseValue(in);
  if (mem) api->ReleaseMemoryInfo(mem);
  return rc == 0 ? 0 : -1;
}

void bindarr_ort_free(float *data) {
  free(data);
}
