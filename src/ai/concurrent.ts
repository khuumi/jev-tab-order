// Wait for every started judgment before surfacing a failure. Pending work must
// not emit progress callbacks after its planning stage has already failed.
export const settleAll = async <T>(work: Promise<T>[]) => {
  const results = await Promise.allSettled(work);
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  return results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
};
