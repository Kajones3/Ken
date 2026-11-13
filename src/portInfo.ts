/**
 * A short write-up for each cruise port, in OUR words (owner, 2026-11-14:
 * "Is there no information we can get on Progreso and Cancun? ... doesn't
 * have to be from Disney"). Facts about a place aren't anyone's property;
 * someone else's sentences are, so nothing here is copied from Disney or a
 * travel site. Plain facts, kept general (no prices, no opening hours) so
 * they don't go stale. The owner can rewrite any of it; see
 * docs/copy/cruise-and-abd-copy.md.
 */
export interface PortStory { about: string; ideas: string[] }

export const PORT_STORIES: Record<string, PortStory> = {
  // Home ports (where you board)
  canaveral: {
    about: "On Florida's Space Coast, about 45 minutes from Orlando's airport. Many families add a few days at Walt Disney World before or after sailing.",
    ideas: ["Kennedy Space Center Visitor Complex", "Cocoa Beach", "A few days at Walt Disney World first"],
  },
  fll: {
    about: "Port Everglades sits minutes from Fort Lauderdale's airport, so it's one of the easiest places to fly in the morning you sail.",
    ideas: ["Fort Lauderdale beach", "A water taxi along the canals", "Las Olas Boulevard"],
  },
  galveston: {
    about: "An island city on the Texas Gulf Coast, about an hour's drive from Houston. Its historic downtown and long beachfront make it an easy place to spend a night before you sail.",
    ideas: ["The Strand historic district", "The beach along the seawall", "Moody Gardens", "Space Center Houston on the way down"],
  },
  sandiego: {
    about: "The cruise terminal is right on San Diego's downtown waterfront, close to the airport. Disneyland is about two hours north.",
    ideas: ["USS Midway Museum, a short walk away", "Balboa Park", "A few days at Disneyland first"],
  },
  vancouver: {
    about: "Ships leave from Canada Place in downtown Vancouver, the usual starting point for Alaska sailings.",
    ideas: ["Stanley Park", "Granville Island", "Capilano Suspension Bridge"],
  },
  // Ports of call (where the ship stops)
  castaway: {
    about: "Disney's own island in the Bahamas. The ship ties up right at the island, so you walk off onto the beach.",
    ideas: ["Family beach and water play area", "An adults-only beach", "Bikes, snorkeling and boat rentals"],
  },
  lookout: {
    about: "Disney's newer beach destination at Lighthouse Point, on the southern tip of the Bahamian island of Eleuthera, opened in 2024.",
    ideas: ["Long beaches with Bahamian culture and food", "Swimming and snorkeling", "Shaded cabanas"],
  },
  nassau: {
    about: "The capital of the Bahamas. Ships dock in the middle of town, so the shops, the waterfront and the beaches are close by.",
    ideas: ["Downtown Nassau and the straw market", "Paradise Island and its beaches", "Snorkeling and boat trips"],
  },
  cozumel: {
    about: "A Mexican island off the Yucatán coast, known for clear water and some of the best reefs in the Caribbean. Cancún is on the mainland, a ferry and a drive away, so most people stay on the island.",
    ideas: ["Snorkeling and diving on the reefs", "Beach clubs", "San Gervasio Maya ruins", "A ferry to Playa del Carmen"],
  },
  progreso: {
    about: "A port on the Gulf side of Mexico's Yucatán, with a pier that runs miles out to sea. It's the gateway to the colonial city of Mérida and to Maya ruins inland.",
    ideas: ["Mérida, about 40 minutes away", "Maya ruins (Dzibilchaltún nearby; Uxmal and Chichén Itzá are long day trips)", "Progreso's beach and boardwalk"],
  },
  ensenada: {
    about: "A port on Mexico's Baja California coast, south of San Diego.",
    ideas: ["La Bufadora, a sea blowhole", "Valle de Guadalupe wine country", "The fish markets and waterfront"],
  },
  cabo: {
    about: "At the very tip of Mexico's Baja California peninsula, where the desert meets the sea.",
    ideas: ["A boat out to El Arco, the famous rock arch", "Whale watching in winter", "Beaches and snorkeling"],
  },
  catalina: {
    about: "An island off the Los Angeles coast. Ships stop off Avalon, a small harbor town you can walk end to end.",
    ideas: ["Glass-bottom boats and snorkeling", "Avalon's waterfront and the Casino building", "Island tours"],
  },
  skagway: {
    about: "A small Alaska town from the Klondike Gold Rush, with its old wooden storefronts still standing.",
    ideas: ["The White Pass & Yukon Route railroad", "Gold Rush history downtown", "Hiking and glacier views"],
  },
  juneau: {
    about: "Alaska's capital, reachable only by sea or air.",
    ideas: ["Mendenhall Glacier", "Whale watching", "The tram up Mount Roberts"],
  },
  ketchikan: {
    about: "A rainforest town in southeast Alaska known for salmon and totem poles.",
    ideas: ["Creek Street on the water", "Totem pole parks", "Floatplanes over Misty Fjords"],
  },
};
