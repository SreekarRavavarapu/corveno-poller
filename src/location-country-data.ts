/**
 * Data for ./location-country.ts: explicit country names outside the seven
 * launch markets, a curated list of unambiguous world cities, the words that
 * mark a remote/hybrid label and the region labels that must never become a
 * country. Matching rules live in ./location-country.ts.
 *
 * Conventions
 * - Names match a complete location segment only (after NFKC, casefold,
 *   diacritic stripping, "&" → "and", periods/apostrophes dropped), never a
 *   substring or a token inside prose.
 * - `worldCountryBlocklist`: display names that also mean something else in a
 *   job location (a US state, a US town, a Channel Island) and therefore never
 *   resolve as a country on their own.
 * - `worldCities`: only places whose dominant reading as a job location is one
 *   city in one non-market country. Names shared with a notable place in a
 *   launch market or in a second country are deliberately absent and listed in
 *   `worldCityBlocklist` so a future edit does not re-add them.
 */

/** Country-name aliases the CLDR display names do not produce (normalised form → ISO2). */
export const worldCountryAliases: Record<string, string> = {
  "uae": "AE", "u a e": "AE", "emirates": "AE", "ksa": "SA", "kingdom of saudi arabia": "SA",
  "south korea": "KR", "korea": "KR", "republic of korea": "KR", "korea republic of": "KR", "north korea": "KP",
  "czech republic": "CZ", "czech": "CZ", "czechia": "CZ", "slovak republic": "SK",
  "russia": "RU", "russian federation": "RU", "viet nam": "VN", "vietnam": "VN",
  "brasil": "BR", "deutschland": "DE", "espana": "ES", "italia": "IT", "polska": "PL",
  "schweiz": "CH", "suisse": "CH", "svizzera": "CH", "osterreich": "AT", "sverige": "SE", "norge": "NO",
  "danmark": "DK", "suomi": "FI", "nederland": "NL", "the netherlands": "NL", "netherlands": "NL",
  "belgique": "BE", "belgie": "BE", "turkiye": "TR", "turkey": "TR",
  "ivory coast": "CI", "cote divoire": "CI", "cote d ivoire": "CI", "myanmar": "MM", "burma": "MM",
  "macau": "MO", "macao": "MO", "hong kong": "HK", "hong kong sar": "HK", "hksar": "HK", "hong kong sar china": "HK",
  "taiwan": "TW", "mainland china": "CN", "prc": "CN", "peoples republic of china": "CN", "china": "CN",
  "republic of ireland": "IE", "eire": "IE", "the philippines": "PH", "philippines": "PH", "the bahamas": "BS",
  "the gambia": "GM", "swaziland": "SZ", "eswatini": "SZ", "north macedonia": "MK", "macedonia": "MK",
  "bosnia and herzegovina": "BA", "bosnia": "BA", "trinidad and tobago": "TT", "trinidad": "TT",
  "saint lucia": "LC", "st lucia": "LC", "antigua": "AG", "antigua and barbuda": "AG",
  "palestine": "PS", "palestinian territories": "PS", "state of palestine": "PS",
  "democratic republic of the congo": "CD", "dr congo": "CD", "drc": "CD", "congo kinshasa": "CD",
  "republic of the congo": "CG", "congo brazzaville": "CG", "timor leste": "TL", "east timor": "TL",
  "cape verde": "CV", "cabo verde": "CV", "curacao": "CW", "kosovo": "XK", "brunei": "BN", "brunei darussalam": "BN",
  "laos": "LA", "lao pdr": "LA", "syria": "SY", "iran": "IR", "moldova": "MD", "republic of moldova": "MD",
  "tanzania": "TZ", "bolivia": "BO", "venezuela": "VE", "faroe islands": "FO", "vatican city": "VA",
  "united arab emirates": "AE", "saudi arabia": "SA", "new zealand": "NZ", "nz": "NZ",
  "south africa": "ZA", "rsa": "ZA", "mexico": "MX", "germany": "DE", "france": "FR", "spain": "ES",
  "italy": "IT", "poland": "PL", "portugal": "PT", "ireland": "IE", "switzerland": "CH", "austria": "AT",
  "sweden": "SE", "norway": "NO", "denmark": "DK", "finland": "FI", "belgium": "BE", "luxembourg": "LU",
  "greece": "GR", "hungary": "HU", "romania": "RO", "bulgaria": "BG", "croatia": "HR", "serbia": "RS",
  "slovenia": "SI", "slovakia": "SK", "ukraine": "UA", "estonia": "EE", "latvia": "LV", "lithuania": "LT",
  "cyprus": "CY", "malta": "MT", "iceland": "IS", "israel": "IL", "egypt": "EG", "kenya": "KE", "nigeria": "NG",
  "ghana": "GH", "morocco": "MA", "tunisia": "TN", "algeria": "DZ", "ethiopia": "ET", "uganda": "UG", "rwanda": "RW",
  "brazil": "BR", "argentina": "AR", "chile": "CL", "colombia": "CO", "peru": "PE", "uruguay": "UY", "ecuador": "EC",
  "costa rica": "CR", "panama": "PA", "guatemala": "GT", "dominican republic": "DO", "honduras": "HN",
  "el salvador": "SV", "nicaragua": "NI", "paraguay": "PY", "jamaica": "JM", "bahamas": "BS", "barbados": "BB",
  "pakistan": "PK", "bangladesh": "BD", "sri lanka": "LK", "nepal": "NP", "indonesia": "ID", "malaysia": "MY",
  "thailand": "TH", "cambodia": "KH", "mongolia": "MN", "kazakhstan": "KZ", "uzbekistan": "UZ", "armenia": "AM",
  "azerbaijan": "AZ", "qatar": "QA", "kuwait": "KW", "bahrain": "BH", "oman": "OM", "jordan": "JO", "lebanon": "LB",
  "iraq": "IQ",
};

/** CLDR display names that must never resolve as a country on their own. */
export const worldCountryBlocklist: readonly string[] = [
  "georgia", // US state far more often than the country in job locations
  "jersey", // Channel Island vs New Jersey shorthand
  "lebanon", // Lebanon PA/NH/OH/TN/IN/OR are common US job locations; "Beirut" still resolves
  "congo", // two countries
  "guinea", // Guinea, Guinea-Bissau, Equatorial Guinea, Papua New Guinea
  "chad", // a first name in some feeds' address lines
  "niger", // Niger vs Nigeria typos in address lines
  "puerto rico", "guam", "us virgin islands", "u s virgin islands", "american samoa", "northern mariana islands",
  "us outlying islands", "u s outlying islands", // US territories: the gazetteer reads Puerto Rico as US
  "united states", "united kingdom", "canada", "australia", "india", "singapore", "japan", // markets: country-evidence.ts owns these
  "antarctica", "bouvet island", "heard and mcdonald islands", "french southern territories",
  "pitcairn islands", "south georgia and south sandwich islands", "british indian ocean territory",
  "svalbard and jan mayen", "western sahara", "reunion", "mayotte", "st martin", "sint maarten",
  "st barthelemy", "caribbean netherlands", "aland islands", "st helena", "tokelau", "niue", "wallis and futuna",
  "christmas island", "cocos keeling islands", "norfolk island", "isle of man", "guernsey",
];

/** Unambiguous world cities (normalised form → ISO2). Whole-segment matches only, medium confidence. */
export const worldCities: Record<string, string> = {
  // Germany
  "berlin": "DE", "munich": "DE", "munchen": "DE", "hamburg": "DE", "frankfurt": "DE", "frankfurt am main": "DE",
  "cologne": "DE", "koln": "DE", "stuttgart": "DE", "dusseldorf": "DE", "dortmund": "DE", "essen": "DE", "leipzig": "DE",
  "bremen": "DE", "dresden": "DE", "hannover": "DE", "nuremberg": "DE", "nurnberg": "DE", "duisburg": "DE",
  "bochum": "DE", "wuppertal": "DE", "bielefeld": "DE", "bonn": "DE", "karlsruhe": "DE", "mannheim": "DE", "augsburg": "DE",
  "wiesbaden": "DE", "aachen": "DE", "braunschweig": "DE", "kiel": "DE", "chemnitz": "DE", "magdeburg": "DE",
  "freiburg": "DE", "freiburg im breisgau": "DE", "mainz": "DE", "lubeck": "DE", "erfurt": "DE", "rostock": "DE",
  "kassel": "DE", "saarbrucken": "DE", "darmstadt": "DE", "regensburg": "DE", "ingolstadt": "DE", "wurzburg": "DE",
  "ulm": "DE", "heilbronn": "DE", "gottingen": "DE", "wolfsburg": "DE", "jena": "DE", "trier": "DE", "erlangen": "DE",
  "paderborn": "DE", "koblenz": "DE", "oberhausen": "DE", "leverkusen": "DE", "garching": "DE", "boblingen": "DE",
  "sindelfingen": "DE", "ludwigsburg": "DE", "esslingen": "DE", "reutlingen": "DE", "tubingen": "DE", "konstanz": "DE",
  "friedrichshafen": "DE", "ottobrunn": "DE", "unterfohring": "DE", "neubiberg": "DE", "idar oberstein": "DE",
  "eschborn": "DE", "bad homburg": "DE", "walldorf": "DE", "ratingen": "DE", "neuss": "DE", "monchengladbach": "DE",
  // Austria, Switzerland
  "wien": "AT", "graz": "AT", "linz": "AT", "salzburg": "AT", "innsbruck": "AT", "klagenfurt": "AT",
  "zurich": "CH", "basel": "CH", "bern": "CH", "berne": "CH", "lausanne": "CH", "lucerne": "CH", "luzern": "CH",
  "winterthur": "CH", "zug": "CH", "lugano": "CH", "st gallen": "CH", "sankt gallen": "CH", "schaffhausen": "CH",
  // France
  "lyon": "FR", "marseille": "FR", "toulouse": "FR", "bordeaux": "FR", "lille": "FR", "nantes": "FR", "strasbourg": "FR",
  "montpellier": "FR", "rennes": "FR", "grenoble": "FR", "sophia antipolis": "FR", "aix en provence": "FR", "toulon": "FR",
  "rouen": "FR", "metz": "FR", "dijon": "FR", "angers": "FR", "le havre": "FR", "reims": "FR", "cannes": "FR",
  "annecy": "FR", "clermont ferrand": "FR", "saint etienne": "FR", "boulogne billancourt": "FR", "issy les moulineaux": "FR",
  "la defense": "FR", "levallois perret": "FR", "neuilly sur seine": "FR", "courbevoie": "FR", "nanterre": "FR",
  "massy": "FR", "saclay": "FR", "palaiseau": "FR", "velizy": "FR", "velizy villacoublay": "FR", "roissy": "FR",
  "valence": "FR", "le kremlin bicetre": "FR", "puteaux": "FR", "montreuil": "FR", "ivry sur seine": "FR",
  "la ciotat": "FR", "sophia": "FR", "biot": "FR", "meudon": "FR", "rueil malmaison": "FR", "saint denis": "FR",
  // Iberia
  "madrid": "ES", "barcelona": "ES", "seville": "ES", "sevilla": "ES", "bilbao": "ES", "zaragoza": "ES", "alicante": "ES",
  "murcia": "ES", "palma": "ES", "palma de mallorca": "ES", "valladolid": "ES", "vigo": "ES", "gijon": "ES",
  "salamanca": "ES", "santander": "ES", "san sebastian": "ES", "donostia": "ES", "pamplona": "ES", "marbella": "ES",
  "ibiza": "ES", "sant cugat": "ES", "sant cugat del valles": "ES", "alcobendas": "ES", "getafe": "ES",
  "lisbon": "PT", "lisboa": "PT", "porto": "PT", "braga": "PT", "coimbra": "PT", "aveiro": "PT", "oeiras": "PT",
  // Italy
  "milan": "IT", "milano": "IT", "turin": "IT", "torino": "IT", "bologna": "IT", "genoa": "IT", "genova": "IT",
  "palermo": "IT", "catania": "IT", "verona": "IT", "padua": "IT", "padova": "IT", "trieste": "IT", "modena": "IT",
  "brescia": "IT", "bergamo": "IT", "bari": "IT", "pisa": "IT", "venezia": "IT", "roma": "IT", "firenze": "IT",
  "napoli": "IT", "cagliari": "IT", "trento": "IT", "bolzano": "IT", "reggio emilia": "IT", "ivrea": "IT",
  // Benelux
  "amsterdam": "NL", "rotterdam": "NL", "the hague": "NL", "den haag": "NL", "utrecht": "NL", "eindhoven": "NL",
  "groningen": "NL", "delft": "NL", "leiden": "NL", "haarlem": "NL", "arnhem": "NL", "nijmegen": "NL", "tilburg": "NL",
  "breda": "NL", "maastricht": "NL", "enschede": "NL", "amersfoort": "NL", "almere": "NL", "hilversum": "NL",
  "hoofddorp": "NL", "schiphol": "NL", "schiphol rijk": "NL", "zwolle": "NL", "apeldoorn": "NL", "wageningen": "NL",
  "veldhoven": "NL", "s hertogenbosch": "NL", "den bosch": "NL", "amstelveen": "NL",
  "brussels": "BE", "bruxelles": "BE", "brussel": "BE", "antwerp": "BE", "antwerpen": "BE", "ghent": "BE", "gent": "BE",
  "leuven": "BE", "bruges": "BE", "brugge": "BE", "liege": "BE", "mechelen": "BE", "namur": "BE", "charleroi": "BE",
  "hasselt": "BE", "kortrijk": "BE", "zaventem": "BE", "diegem": "BE", "louvain la neuve": "BE",
  "luxembourg city": "LU", "esch sur alzette": "LU",
  // Nordics, Baltics, Ireland
  "stockholm": "SE", "gothenburg": "SE", "goteborg": "SE", "malmo": "SE", "uppsala": "SE", "lund": "SE",
  "linkoping": "SE", "vasteras": "SE", "orebro": "SE", "helsingborg": "SE", "solna": "SE", "kista": "SE",
  "copenhagen": "DK", "kobenhavn": "DK", "aarhus": "DK", "arhus": "DK", "odense": "DK", "aalborg": "DK",
  "oslo": "NO", "trondheim": "NO", "stavanger": "NO", "helsinki": "FI", "espoo": "FI", "tampere": "FI", "turku": "FI",
  "oulu": "FI", "vantaa": "FI", "reykjavik": "IS", "cork": "IE", "galway": "IE", "limerick": "IE", "athlone": "IE",
  "vilnius": "LT", "kaunas": "LT", "riga": "LV", "tallinn": "EE", "tartu": "EE",
  // Central and Eastern Europe
  "warsaw": "PL", "warszawa": "PL", "krakow": "PL", "cracow": "PL", "wroclaw": "PL", "poznan": "PL", "gdansk": "PL",
  "lodz": "PL", "katowice": "PL", "lublin": "PL", "szczecin": "PL", "bydgoszcz": "PL", "gdynia": "PL", "bialystok": "PL",
  "rzeszow": "PL", "prague": "CZ", "praha": "CZ", "brno": "CZ", "ostrava": "CZ", "plzen": "CZ", "pilsen": "CZ",
  "olomouc": "CZ", "bratislava": "SK", "kosice": "SK", "budapest": "HU", "debrecen": "HU", "szeged": "HU",
  "bucharest": "RO", "bucuresti": "RO", "cluj napoca": "RO", "cluj": "RO", "timisoara": "RO", "iasi": "RO",
  "brasov": "RO", "constanta": "RO", "sibiu": "RO", "oradea": "RO", "craiova": "RO", "sofia": "BG", "plovdiv": "BG",
  "varna": "BG", "burgas": "BG", "thessaloniki": "GR", "patras": "GR", "heraklion": "GR", "ioannina": "GR",
  "belgrade": "RS", "beograd": "RS", "novi sad": "RS", "nis": "RS", "zagreb": "HR", "rijeka": "HR", "ljubljana": "SI",
  "maribor": "SI", "sarajevo": "BA", "skopje": "MK", "podgorica": "ME", "tirana": "AL", "pristina": "XK",
  "kyiv": "UA", "kiev": "UA", "lviv": "UA", "kharkiv": "UA", "odesa": "UA", "dnipro": "UA", "chisinau": "MD",
  "minsk": "BY", "novosibirsk": "RU", "yekaterinburg": "RU", "kazan": "RU", "nizhny novgorod": "RU",
  "istanbul": "TR", "ankara": "TR", "izmir": "TR", "bursa": "TR", "antalya": "TR", "nicosia": "CY", "limassol": "CY",
  "larnaca": "CY", "valletta": "MT", "sliema": "MT", "birkirkara": "MT",
  // Middle East
  "dubai": "AE", "abu dhabi": "AE", "sharjah": "AE", "doha": "QA", "riyadh": "SA", "jeddah": "SA", "dammam": "SA",
  "al khobar": "SA", "khobar": "SA", "manama": "BH", "muscat": "OM", "kuwait city": "KW", "amman": "JO", "beirut": "LB",
  "baghdad": "IQ", "erbil": "IQ", "tehran": "IR", "tel aviv": "IL", "tel aviv yafo": "IL", "haifa": "IL",
  "herzliya": "IL", "herzliya pituach": "IL", "netanya": "IL", "raanana": "IL", "ra anana": "IL", "petah tikva": "IL",
  "petach tikva": "IL", "rehovot": "IL", "beersheba": "IL", "beer sheva": "IL", "ramat gan": "IL", "kfar saba": "IL",
  "modiin": "IL", "modi in": "IL", "yokneam": "IL", "caesarea": "IL", "rosh haayin": "IL", "rosh ha ayin": "IL",
  "hod hasharon": "IL", "or yehuda": "IL", "holon": "IL", "ashdod": "IL", "eilat": "IL", "bnei brak": "IL",
  // Africa
  "cairo": "EG", "giza": "EG", "casablanca": "MA", "rabat": "MA", "marrakech": "MA", "marrakesh": "MA", "tangier": "MA",
  "tunis": "TN", "algiers": "DZ", "niamey": "NE", "lagos": "NG", "abuja": "NG", "port harcourt": "NG", "accra": "GH", "kumasi": "GH",
  "nairobi": "KE", "mombasa": "KE", "kampala": "UG", "kigali": "RW", "dar es salaam": "TZ", "addis ababa": "ET",
  "lusaka": "ZM", "harare": "ZW", "johannesburg": "ZA", "cape town": "ZA", "durban": "ZA", "pretoria": "ZA",
  "stellenbosch": "ZA", "sandton": "ZA", "midrand": "ZA", "durbanville": "ZA", "port louis": "MU", "dakar": "SN",
  "abidjan": "CI", "luanda": "AO", "maputo": "MZ", "gaborone": "BW", "windhoek": "NA", "antananarivo": "MG",
  // East and South-East Asia
  "beijing": "CN", "peking": "CN", "shanghai": "CN", "shenzhen": "CN", "guangzhou": "CN", "hangzhou": "CN",
  "chengdu": "CN", "nanjing": "CN", "wuhan": "CN", "suzhou": "CN", "xian": "CN", "xi an": "CN", "tianjin": "CN",
  "chongqing": "CN", "qingdao": "CN", "dalian": "CN", "xiamen": "CN", "dongguan": "CN", "ningbo": "CN", "hefei": "CN",
  "zhengzhou": "CN", "changsha": "CN", "kunming": "CN", "harbin": "CN", "shenyang": "CN", "jinan": "CN", "fuzhou": "CN",
  "wuxi": "CN", "taipei": "TW", "new taipei": "TW", "taichung": "TW", "kaohsiung": "TW", "tainan": "TW", "hsinchu": "TW",
  "seoul": "KR", "busan": "KR", "incheon": "KR", "daegu": "KR", "daejeon": "KR", "gwangju": "KR", "suwon": "KR",
  "pangyo": "KR", "seongnam": "KR", "bundang": "KR", "manila": "PH", "makati": "PH", "taguig": "PH",
  "bonifacio global city": "PH", "bgc": "PH", "quezon city": "PH", "pasig": "PH", "cebu": "PH", "cebu city": "PH",
  "davao": "PH", "davao city": "PH", "ortigas": "PH", "bangkok": "TH", "chiang mai": "TH", "phuket": "TH", "pattaya": "TH",
  "kuala lumpur": "MY", "petaling jaya": "MY", "cyberjaya": "MY", "johor bahru": "MY", "shah alam": "MY",
  "subang jaya": "MY", "penang": "MY", "jakarta": "ID", "surabaya": "ID", "bandung": "ID", "bali": "ID", "denpasar": "ID",
  "yogyakarta": "ID", "medan": "ID", "semarang": "ID", "makassar": "ID", "batam": "ID", "tangerang": "ID", "bekasi": "ID",
  "bogor": "ID", "depok": "ID", "hanoi": "VN", "ha noi": "VN", "ho chi minh city": "VN", "ho chi minh": "VN",
  "hcmc": "VN", "saigon": "VN", "da nang": "VN", "danang": "VN", "phnom penh": "KH", "vientiane": "LA", "yangon": "MM",
  "colombo": "LK", "dhaka": "BD", "chittagong": "BD", "chattogram": "BD", "karachi": "PK", "lahore": "PK",
  "islamabad": "PK", "rawalpindi": "PK", "faisalabad": "PK", "peshawar": "PK", "kathmandu": "NP", "thimphu": "BT",
  "ulaanbaatar": "MN", "almaty": "KZ", "astana": "KZ", "nur sultan": "KZ", "tashkent": "UZ", "bishkek": "KG",
  "dushanbe": "TJ", "ashgabat": "TM", "baku": "AZ", "yerevan": "AM", "tbilisi": "GE",
  // Americas
  "mexico city": "MX", "ciudad de mexico": "MX", "cdmx": "MX", "guadalajara": "MX", "monterrey": "MX", "queretaro": "MX",
  "tijuana": "MX", "puebla": "MX", "cancun": "MX", "hermosillo": "MX", "chihuahua": "MX", "aguascalientes": "MX",
  "san luis potosi": "MX", "toluca": "MX", "ciudad juarez": "MX", "juarez": "MX", "mexicali": "MX", "saltillo": "MX",
  "zapopan": "MX", "guatemala city": "GT", "ciudad de guatemala": "GT", "san salvador": "SV", "tegucigalpa": "HN",
  "san pedro sula": "HN", "managua": "NI", "havana": "CU", "la habana": "CU", "santo domingo": "DO",
  "port au prince": "HT", "port of spain": "TT", "bridgetown": "BB", "bogota": "CO", "medellin": "CO",
  "barranquilla": "CO", "bucaramanga": "CO", "pereira": "CO", "caracas": "VE", "maracaibo": "VE", "quito": "EC",
  "guayaquil": "EC", "arequipa": "PE", "cusco": "PE", "cuzco": "PE", "cochabamba": "BO", "vina del mar": "CL",
  "concepcion": "CL", "buenos aires": "AR", "rosario": "AR", "mendoza": "AR", "mar del plata": "AR", "montevideo": "UY",
  "asuncion": "PY", "sao paulo": "BR", "rio de janeiro": "BR", "belo horizonte": "BR", "brasilia": "BR", "curitiba": "BR",
  "porto alegre": "BR", "recife": "BR", "salvador": "BR", "fortaleza": "BR", "campinas": "BR", "florianopolis": "BR",
  "manaus": "BR", "belem": "BR", "goiania": "BR", "barueri": "BR", "osasco": "BR", "sao jose dos campos": "BR",
  "joinville": "BR", "blumenau": "BR", "ribeirao preto": "BR", "sorocaba": "BR", "santos": "BR", "niteroi": "BR",
  "uberlandia": "BR", "londrina": "BR", "maringa": "BR", "alphaville": "BR",
  // Oceania outside Australia
  "auckland": "NZ", "christchurch": "NZ", "dunedin": "NZ", "tauranga": "NZ", "suva": "FJ", "port moresby": "PG",
  "noumea": "NC",
};

/** World-city names deliberately NOT in `worldCities` and why (checked by tests). */
export const worldCityBlocklist: Record<string, string> = {
  paris: "Paris TX/ON (gazetteer modifier)", dublin: "Dublin CA/OH", athens: "Athens GA/OH", rome: "Rome GA/NY",
  florence: "Florence AL/SC/KY", naples: "Naples FL", venice: "Venice FL/CA", vienna: "Vienna VA", geneva: "Geneva IL/NY",
  moscow: "Moscow ID", lima: "Lima OH", odessa: "Odessa TX", toledo: "Toledo OH", valencia: "Valencia CA / Venezuela",
  cordoba: "Argentina or Spain", santiago: "Chile, Spain, Dominican Republic, Cuba", "san jose": "San Jose CA",
  "panama city": "Panama City FL", nassau: "Nassau County NY", kingston: "gazetteer modifier", georgetown: "gazetteer modifier",
  hamilton: "gazetteer modifier", victoria: "gazetteer modifier", wellington: "Wellington CO/FL/OH", nelson: "gazetteer modifier",
  hastings: "gazetteer modifier", cali: "California shorthand", merida: "Mexico, Spain, Venezuela", leon: "Mexico, Spain, Nicaragua",
  cartagena: "Colombia or Spain", "la paz": "Bolivia or Mexico", "santa fe": "Argentina or New Mexico", trujillo: "Peru, Honduras, Spain",
  nice: "ordinary word", split: "ordinary word", bergen: "Bergen County NJ", waterford: "Waterford MI/CT/NY",
  shannon: "a name and a river", granada: "Spain or Nicaragua", parma: "Parma OH", munster: "Munster IN",
  potsdam: "Potsdam NY", halle: "Germany or Belgium", heidelberg: "gazetteer modifier", coburg: "gazetteer modifier",
  baden: "Germany, Austria, Switzerland, Ontario", valparaiso: "Valparaiso IN", "la plata": "La Plata MD",
  vitoria: "Brazil or Spain", hanover: "Hanover MD/NH/PA (Hannover still resolves)", malaga: "gazetteer modifier (Perth suburb)", natal: "ordinary word", male: "ordinary word", jerusalem: "not resolved deterministically",
  "saint petersburg": "St Petersburg FL (gazetteer)", "st petersburg": "St Petersburg FL (gazetteer)", canton: "gazetteer modifier",
  alexandria: "gazetteer modifier", "santa cruz": "gazetteer modifier", queenstown: "gazetteer modifier", como: "ordinary word",
  "sao jose": "Brazil or Costa Rica", cambridge: "gazetteer modifier", manchester: "gazetteer modifier", birmingham: "gazetteer modifier",
};

/** Words that mark a remote/hybrid/on-site label; stripped before country lookup. */
export const remoteWordPattern =
  "(?:fully\\s+|100%\\s+|full\\s+|partially\\s+|mostly\\s+)?(?:remote|remoto|remota|teletrabajo|teletravail|télétravail|hybrid|hibrido|híbrido|home[\\s-]?based|home[\\s-]?office|work[\\s-]+from[\\s-]+home|wfh|telecommute|telework|virtual|distributed|on[\\s-]?site|in[\\s-]?office|office[\\s-]?based|flexible)(?:[\\s-]+(?:work|working|role|roles|position|job|jobs|eligible|friendly|first|ok|okay|possible|available|option|optional|only|allowed))?";

/** Labels naming a region, continent or scope rather than a country. Never a country; recorded as scope. */
export const regionScopeLabels: readonly string[] = [
  "emea", "apac", "apj", "latam", "lat am", "amer", "amers", "namer", "na", "eu", "europe", "european union",
  "eu uk", "uk eu", "asia", "asia pacific", "asia pac", "asiapac", "africa", "americas", "north america", "south america",
  "latin america", "central america", "caribbean", "middle east", "mena", "menat", "gcc", "nordics", "nordic",
  "scandinavia", "benelux", "dach", "cee", "cis", "anz", "oceania", "australasia", "eastern europe", "western europe",
  "southern europe", "northern europe", "central europe", "southeast asia", "south east asia", "south asia", "east asia",
  "sub saharan africa", "west africa", "east africa", "north africa", "southern africa", "global", "worldwide",
  "world wide", "international", "anywhere", "anywhere in the world", "multiple locations", "multiple", "various",
  "various locations", "other", "tbd", "tbc", "location tbd", "to be determined", "n a", "none", "unknown",
  "flexible", "distributed", "us timezones", "us time zones", "est", "pst", "cst", "mst", "cet", "gmt", "utc",
  "east coast", "west coast", "midwest", "southeast", "northeast", "southwest", "northwest", "pacific", "atlantic",
  "select locations", "all locations", "any", "any location", "open", "everywhere", "home", "field", "travel",
  "traveling", "travelling", "nationwide", "national", "regional", "onsite", "on site", "hybrid", "remote",
];
