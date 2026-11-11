import { Link, Navigate, useParams } from "react-router-dom";
import SiteFooter from "../components/SiteFooter.jsx";
import { cafePath } from "../lib/api.js";
import { useSiteConfig } from "../lib/config.js";

// Contact details come from the staff panel (Café setup). The placeholders stay visible on purpose
// until the owner fills them in: Razorpay's website review looks for real details on exactly these
// pages, and a blank line would hide the omission.
function businessDetails(config) {
  const cafe = (config && config.cafe) || {};
  return {
    name: String(cafe.name || "").trim() || "[Business Name]",
    address: String(cafe.address || "").trim() || "[Address]",
    phone: String(cafe.phone || "").trim() || "[Phone]",
    email: String(cafe.email || "").trim() || "[Email]",
  };
}

function pagesFor({ name, address, phone, email }) {
  return {
    about: {
      title: "About us",
      body: (
        <>
          <p>
            {name} is a café at {address}. Order straight from your phone and pay without waiting for
            someone to take your order.
          </p>
          <p>
            Food is prepared to order in our kitchen. We keep a small menu, change it with the season,
            and mark anything that has sold out the moment it runs out.
          </p>
          <p>
            Questions before you visit? Call {phone} or write to {email}.
          </p>
        </>
      ),
    },
    contact: {
      title: "Contact us",
      body: (
        <>
          <p>We answer messages during opening hours and aim to reply the same day.</p>
          <ul className="legal-list">
            <li>
              <strong>Business:</strong> {name}
            </li>
            <li>
              <strong>Address:</strong> {address}
            </li>
            <li>
              <strong>Phone:</strong> {phone}
            </li>
            <li>
              <strong>Email:</strong> {email}
            </li>
          </ul>
          <p className="muted small">
            For anything about a specific order, quote the order number shown on your receipt — it
            makes it much faster to find.
          </p>
        </>
      ),
    },
    pricing: {
      title: "Pricing details",
      body: (
        <>
          <p>
            The price of every dish and drink is listed on the live menu, inclusive of taxes unless
            stated otherwise. There is no service charge, cover charge or platform fee added at
            checkout.
          </p>
          <p>
            <Link className="btn ghost small-btn" to={cafePath("/menu")}>
              See the live menu and prices
            </Link>
          </p>
          <p className="muted small">
            Menu prices can change without notice; the amount shown when you confirm your order is the
            amount you pay.
          </p>
        </>
      ),
    },
    terms: {
      title: "Terms and conditions",
      body: (
        <>
          <p>
            These terms apply to orders placed at {name} through this website. By placing an order you
            agree to them.
          </p>
          <h2>Orders</h2>
          <p>
            An order is an offer to buy the items listed at the prices shown. It is accepted when the
            kitchen starts preparing it. We may decline or cancel an order if an item is unavailable,
            if the table or pickup number cannot be verified, or if a payment cannot be confirmed.
          </p>
          <h2>Payment</h2>
          <p>
            Payments are processed by our payment gateway. We never see or store your card, UPI PIN or
            bank credentials. An order is only treated as paid once the gateway confirms the payment to
            us.
          </p>
          <h2>Dine-in and pickup</h2>
          <p>
            Menu prices can change without notice; the amount shown when you confirm your order is the
            amount you pay. Orders are for collection at the counter or service at the table they were
            placed for, and are not available for delivery unless staff agree.
          </p>
          <h2>Liability</h2>
          <p>
            Please tell staff about any allergy before ordering. Our kitchen handles nuts, dairy,
            gluten and other allergens, so we cannot guarantee an allergen-free preparation area.
          </p>
          <h2>Contact</h2>
          <p>
            {name}, {address} · {phone} · {email}
          </p>
        </>
      ),
    },
    privacy: {
      title: "Privacy policy",
      body: (
        <>
          <p>
            {name} collects the minimum needed to serve you: the table or pickup number, the items you
            order, the amount, and — when you pay online — the payment reference returned by our
            payment gateway.
          </p>
          <h2>What we do not collect</h2>
          <p>
            We do not ask for your name, email, phone number or address to place an order, and we never
            receive your card number or UPI PIN. Those stay with the payment gateway and your bank.
          </p>
          <h2>Payments</h2>
          <p>
            Online payments are processed by our payment gateway under its own privacy policy. We
            receive only a confirmation, an amount and a payment identifier so we can match the payment
            to your order.
          </p>
          <h2>Retention</h2>
          <p>
            Order records are kept for accounting and dispute resolution, then deleted. We do not sell
            or rent data to anyone.
          </p>
          <h2>Your choices</h2>
          <p>
            Write to {email} to ask what we hold about an order, or to have it deleted where we are not
            required to keep it.
          </p>
        </>
      ),
    },
    refund: {
      title: "Cancellation and refund policy",
      body: (
        <>
          <p>
            Because food is prepared to order, cancellation is only possible before the kitchen starts
            preparing it. Ask staff as soon as possible.
          </p>
          <h2>When we refund in full</h2>
          <ul className="legal-list">
            <li>You were charged but the order was never prepared.</li>
            <li>An item you paid for was unavailable and you do not want a replacement.</li>
            <li>You were charged twice for the same order.</li>
            <li>The amount charged does not match the amount shown when you ordered.</li>
          </ul>
          <h2>How refunds are paid</h2>
          <p>
            Refunds go back to the original payment method through our payment gateway. We initiate
            them within 2 working days; your bank typically credits the amount in 5–7 working days.
          </p>
          <h2>What we cannot refund</h2>
          <p>
            Food already prepared and served, and orders cancelled after preparation has started, are
            not refundable. If something was wrong with your food, tell us while you are still there
            and we will make it right.
          </p>
          <h2>Requesting a refund</h2>
          <p>
            Call {phone} or email {email} with your order number and the payment reference. {name},{" "}
            {address}.
          </p>
        </>
      ),
    },
  };
}

export default function Legal({ page: fixedPage }) {
  // Served from /c/:slug/<page>; an unknown page falls back to the landing page rather than a
  // policy page that does not exist.
  const params = useParams();
  const page = fixedPage || params.legal;
  const config = useSiteConfig();
  const details = businessDetails(config);
  const pages = pagesFor(details);
  if (!pages[page]) return <Navigate to={cafePath("")} replace />;
  const content = pages[page];

  return (
    <main className="legal-page">
      <Link className="back-link" to={cafePath("")}>
        ← Back to the menu
      </Link>
      <h1>{content.title}</h1>
      <p className="muted small">
        {details.name} · {details.address}
      </p>
      <div className="legal-body">{content.body}</div>
      <SiteFooter />
    </main>
  );
}
