let loading;

export function loadRazorpay() {
  if (typeof window !== "undefined" && window.Razorpay) return Promise.resolve(window.Razorpay);

  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.async = true;
      script.onload = () => {
        if (window.Razorpay) resolve(window.Razorpay);
        else reject(new Error("Razorpay Checkout didn't load."));
      };
      script.onerror = () => {
        loading = undefined;
        reject(new Error("Couldn't reach Razorpay — check your connection and try again."));
      };
      document.body.appendChild(script);
    });
  }

  return loading;
}
