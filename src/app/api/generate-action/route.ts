import { createClient } from "@/lib/supabase/server";
import { getBrandId } from "@/lib/brand";
import { RETURN_TYPE_LABELS } from "@/lib/returns";
import { RODEBJER_STORE_FOOTER, getSignoffName } from "@/lib/messageSignature";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();

// Ger en grammatiskt korrekt svensk formulering av ett förflutet datum,
// t.ex. "i torsdags" (aldrig "på torsdag", som syftar på en kommande dag).
function relativeSwedishDayPhrase(dateStr: string): string {
  const days = Math.max(0, Math.round((Date.now() - new Date(dateStr).getTime()) / 86_400_000));
  if (days === 0) return "idag";
  if (days === 1) return "igår";
  if (days <= 6) {
    const weekdays = ["i söndags", "i måndags", "i tisdags", "i onsdags", "i torsdags", "i fredags", "i lördags"];
    return weekdays[new Date(dateStr).getDay()];
  }
  return `för ${days} dagar sedan`;
}

export async function POST(request: Request) {
  const supabase = await createClient();

  const body = await request.json() as {
    customer_id?: string;
    type?: "prediction" | "thank_you" | "follow_up";
    prediction?: {
      product: string;
      product_type?: string | null;
      date: string;
      daysUntil: number;
      confidence: number;
      reason: string;
    };
    follow_up_context?: string;
    rep_name?: string | null;
    rep_email?: string | null;
  };

  const { customer_id, prediction, rep_name, rep_email } = body;
  const type = body.type ?? "prediction";
  const followUpContext = body.follow_up_context?.trim() || null;
  if (!customer_id) return Response.json({ error: "customer_id krävs" }, { status: 400 });
  if (type === "follow_up" && !followUpContext) {
    return Response.json({ error: "Beskriv vad du vill följa upp om" }, { status: 400 });
  }

  const brandId = await getBrandId();
  if (!brandId) return Response.json({ error: "Inget varumärke hittades" }, { status: 404 });

  const { data: brandsData } = await supabase
    .from("brands")
    .select("id, name, slug")
    .eq("id", brandId)
    .limit(1);

  const brand = brandsData?.[0] as { id: string; name: string; slug: string } | undefined;
  if (!brand) return Response.json({ error: "Inget varumärke hittades" }, { status: 404 });

  const isRodebjer =
    brand.slug === "rodebjer" || process.env.NEXT_PUBLIC_BRAND_MODE === "rodebjer";

  const brandVoiceSection = isRodebjer
    ? `
--- BRAND VOICE: RODEBJER ---
Du skriver som en säljare på Rodebjer, ett svenskt modevarumärke grundat 2000 av Carin Rodebjer. Skriv som ett kort, personligt mejl från en riktig människa i butiken som känner kunden — vardagligt, varmt, rakt på sak. ALDRIG högtravande, ALDRIG som en dikt eller en kampanjtext. Om en mening låter som reklamcopy — skriv om den enklare.

REGLER:
1. Hälsning: "Hej [förnamn]," — aldrig "Kära" eller andra högtravande hälsningsfraser
2. Skriv som du skulle mejla en kund du känner professionellt — enkla meningar, vardagsspråk, inte "editorial" ton
3. Produkter kan nämnas med "The [Namn]"-prefix om du refererar en specifik produkt (t.ex. "The Karlai") — men tvinga inte in poetiska material- eller känslobeskrivningar i varje mening. Nämn material bara när det känns naturligt, aldrig som utsmyckning
4. Inga utropstecken, aldrig
5. Inga hype-ord: amazing, incredible, must-have, trendy, VIP, exclusive, deal, save, discount, shop now, limited time
6. Avsluta enkelt och genuint — t.ex. en inbjudan att komma förbi butiken. Inte en säljpitch, inte en uppmaning i imperativ ("Handla nu")
7. Skriv INGEN avslutande hälsningsfras eller signatur — meddelandet ska sluta med sista innehållsmeningen. Signatur och kontaktuppgifter läggs till automatiskt efteråt.
8. Referera till produkten som den typ den faktiskt är — om det är en mössa säg "mössa", aldrig som ett plagg om det inte är det

--- OM KOLLEKTIONEN (FW26) — Carin Rodebjers egna ord, använd bara om det är relevant för meddelandet, tvinga inte in det ---
"Fall/Winter 2026 symboliserar nya början. Det är Rodebjer destillerat: rosor, hästar, ruter, manchester, fransar och rosetter. Jag ville skapa från intuition och hjärta — göra kläder snarare än mode. Resultatet är en kollektion grundad i vardaglig bärbarhet, uttryckt genom en genuin Rodebjer-estetik. Tanken att gå tillbaka till grunderna kändes djupt lockande. Att fokusera på hantverket i att göra kläder."

EXEMPEL PÅ RÄTT TON (fritt översatt från ett riktigt Rodebjer-mejl):
"Hej Emma,

Hoppas allt är bra med dig. Den här veckan lanserar vi vårt första drop av FW26. Tankarna kanske fortfarande är kvar i sommaren, men jag ville ändå bjuda på lite inspiration inför säsongen som kommer. Carin Rodebjer själv beskriver kollektionen som en känsla av styrka, frihet och attraktion — jag hoppas du kan känna det.

Om du är nyfiken är du mer än välkommen att komma förbi butiken, så visar jag kollektionen för dig personligen."
`
    : "";

  const [{ data: customerData }, { data: ordersData }] = await Promise.all([
    supabase
      .from("customers")
      .select("id, email, first_name, last_name, total_spent, order_count, last_order_at, notes")
      .eq("id", customer_id)
      .eq("brand_id", brand.id)
      .single(),
    supabase
      .from("orders")
      .select("total, created_at, items")
      .eq("customer_id", customer_id)
      .order("created_at", { ascending: false })
      .limit(5),
  ]);

  if (!customerData) return Response.json({ error: "Kund hittades inte" }, { status: 404 });

  const customer = customerData as {
    email: string;
    first_name: string | null;
    last_name: string | null;
    total_spent: number | null;
    order_count: number | null;
    last_order_at: string | null;
    notes: string | null;
  };

  const orders = (ordersData ?? []) as { total: number; created_at: string; items: unknown[] }[];

  let latestInStoreOrder: { total: number; created_at: string; items: unknown[] } | null = null;
  if (type === "thank_you") {
    const { data: inStoreOrderData } = await supabase
      .from("orders")
      .select("total, created_at, items")
      .eq("customer_id", customer_id)
      .eq("channel", "in_store")
      .order("created_at", { ascending: false })
      .limit(1);
    const inStoreOrders = (inStoreOrderData ?? []) as { total: number; created_at: string; items: unknown[] }[];
    latestInStoreOrder = inStoreOrders[0] ?? null;

    if (!latestInStoreOrder) {
      return Response.json({ error: "Kunden har inga köp i butik registrerade" }, { status: 400 });
    }
  }

  const firstName = customer.first_name ?? customer.email.split("@")[0];
  const fullName = [customer.first_name, customer.last_name].filter(Boolean).join(" ") || customer.email;

  // Undvik att räkna det köp vi tackar för som "tidigare köpt" — annars tror
  // modellen att kunden köpt samma plagg två gånger och skriver "igen".
  const historyOrders =
    type === "thank_you" && latestInStoreOrder
      ? orders.filter((o) => o.created_at !== latestInStoreOrder!.created_at)
      : orders;

  const lastItems = historyOrders.slice(0, 3).flatMap((o) => {
    if (!Array.isArray(o.items)) return [];
    return o.items.map((item) => {
      if (typeof item === "object" && item !== null) {
        const it = item as Record<string, unknown>;
        return String(it.name ?? it.title ?? it.product_name ?? "").trim();
      }
      return String(item).trim();
    }).filter(Boolean);
  });

  const lastItemsText = lastItems.length > 0 ? lastItems.slice(0, 4).join(", ") : null;
  const totalSpent = (customer.total_spent ?? 0).toLocaleString("sv");
  const orderCount = customer.order_count ?? 0;
  const daysSinceLast = customer.last_order_at
    ? Math.round((Date.now() - new Date(customer.last_order_at).getTime()) / 86_400_000)
    : null;

  const predProduct = prediction?.product ?? "ett nytt plagg";
  const predType = prediction?.product_type ? RETURN_TYPE_LABELS[prediction.product_type] ?? null : null;
  const predDate = prediction?.date ?? "inom kort";
  const predDays = prediction?.daysUntil ?? 14;
  const predReason = prediction?.reason ?? "";

  const latestOrder = latestInStoreOrder;
  const latestOrderItemsText = latestOrder
    ? (Array.isArray(latestOrder.items) ? latestOrder.items : []).map((item) => {
        if (typeof item === "object" && item !== null) {
          const it = item as Record<string, unknown>;
          return String(it.name ?? it.title ?? it.product_name ?? "").trim();
        }
        return String(item).trim();
      }).filter(Boolean).join(", ") || null
    : null;
  const latestOrderDate = latestOrder ? relativeSwedishDayPhrase(latestOrder.created_at) : null;

  const taskLine =
    type === "thank_you"
      ? "Skriv ett kort, varmt tackmeddelande som säljaren skickar direkt till kunden efter ett köp i butiken."
      : type === "follow_up"
      ? "Skriv ett kort uppföljningsmeddelande som säljaren skickar direkt till kunden, baserat på kontexten säljaren gett nedan."
      : "Skriv ett kort, personligt utgående meddelande som säljaren ska skicka direkt till kunden, baserat på en AI-prediktion om vad kunden troligen köper härnäst.";

  const typeSection =
    type === "thank_you"
      ? `SENASTE KÖP (det som ska tackas för):
${latestOrderItemsText ? `- Köpte: ${latestOrderItemsText}` : "- Köpte: ett plagg i butiken"}
${latestOrder ? `- Summa: ${latestOrder.total.toLocaleString("sv")} kr` : ""}
${latestOrderDate ? `- När: "${latestOrderDate}" (använd EXAKT denna formulering för tidpunkten, ändra den inte — t.ex. inte "på torsdag" om det står "i torsdags")` : ""}`
      : type === "follow_up"
      ? `UPPFÖLJNING — KONTEXT FRÅN SÄLJAREN:
- ${followUpContext}`
      : `AI-PREDIKTION:
- Kunden förväntas köpa: ${predProduct}${predType ? ` (${predType})` : ""}
- Inom: ${predDays} dagar (ca ${predDate})
${predReason ? `- Anledning: ${predReason}` : ""}`;

  const contentInstruction =
    type === "thank_you"
      ? "- Tacka specifikt för det kunden just köpte, nämn plagget/plaggen naturligt — inget säljande, bara uppriktig tack. Säg inte att kunden köpt plagget \"igen\" eller \"en gång till\" om det inte uttryckligen står i \"Tidigare köpt\" — anta aldrig upprepningar som inte finns i datan"
      : type === "follow_up"
      ? "- Utgå från kontexten säljaren gett ovan och följ upp naturligt, som ett brev från någon som kommer ihåg samtalet"
      : `- Nämn ett specifikt plagg eller kategori kopplat till prediktionen — naturligt, inte påtvingat
- Referera till produkten som den typ den faktiskt är — om det är en mössa säg "mössa" eller beskriv den som en accessoar, aldrig som ett plagg. Om typ saknas — beskriv produkten neutralt utan att gissa kategori.`;

  const closingInstruction =
    type === "thank_you"
      ? "- Avsluta varmt, gärna med en invit att höra av sig om något behövs"
      : type === "follow_up"
      ? "- Avsluta med ett konkret nästa steg kopplat till uppföljningen"
      : "- Avsluta med ett konkret nästa steg: boka tid, kom in, ta en titt";

  const prompt = `Du är säljarens assistent på ${brand.name}, ett mode/beauty-varumärke med sofistikerat och personligt tonläge.

UPPGIFT: ${taskLine} Det ska kännas som att en verklig person skriver — inte ett nyhetsbrev, inte en säljpitch.

KUNDINFO:
- Namn: ${fullName} (tilltala som "${firstName}")
- Totalt spenderat: ${totalSpent} kr
- Antal köp: ${orderCount}
${daysSinceLast !== null ? `- Dagar sedan senaste köp: ${daysSinceLast}` : ""}
${lastItemsText ? `- Tidigare köpt: ${lastItemsText}` : ""}
${customer.notes ? `- Säljarens anteckning: ${customer.notes}` : ""}

${typeSection}
${brandVoiceSection}
INSTRUKTIONER:
- Skriv på svenska, varmt och personligt — men lätt och ledigt i tonfallet, som ett sms till någon du känner, inte som ett vykort
- Skriv ALDRIG klyschor eller vaga känslomeningar av typen "det betyder mer än du kanske tror", "det värmer verkligen" eller "du är så uppskattad" — håll dig till konkreta, sanna saker
- Hitta inte på detaljer som inte finns i KUNDINFO eller ovan — t.ex. att kunden rekommenderar butiken till vänner, om det inte uttryckligen står angivet
${contentInstruction}
- Max 5 meningar, gärna i 2–3 korta stycken — som ett riktigt mejl, inte en enda lång text
${closingInstruction}
${
  isRodebjer
    ? `- Skriv ingen signatur eller avslutningsfras (se regel ovan) — den läggs till automatiskt`
    : `- Signera med säljarens namn: "${rep_name ?? "teamet på " + brand.name}"${rep_email ? ` och e-post: ${rep_email}` : ""}`
}
- Inga emojis, inga utropstecken i onödan
- Känn igen kunden som en stammis om de handlat mer än 2 ggr

Svara ENBART med meddelandet, ingen förklaring, ingen rubrik.`;

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });

    let text = message.content[0].type === "text" ? message.content[0].text.trim() : "";
    if (!text) throw new Error("Tomt svar från AI");

    if (isRodebjer) {
      const signoffName = getSignoffName(rep_name);
      text = [text, signoffName, RODEBJER_STORE_FOOTER].filter(Boolean).join("\n\n");
    }

    return Response.json({ message: text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Okänt fel";
    const isKeyError = msg.toLowerCase().includes("api key") || msg.toLowerCase().includes("authentication");
    return Response.json(
      { error: isKeyError ? "ANTHROPIC_API_KEY saknas eller är ogiltig" : `Kunde inte generera meddelande: ${msg}` },
      { status: 500 }
    );
  }
}
