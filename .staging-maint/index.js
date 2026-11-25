export default {
  async fetch() {
    return new Response(JSON.stringify({ status: "staging", message: "Staging environment not yet available." }), {
      status: 503,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  },
};