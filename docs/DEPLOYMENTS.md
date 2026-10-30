# MySun — Robinhood Chain 部署地址

供 integrators、indexers 與 dashboards 使用。以下為 Robinhood Chain（Arbitrum Orbit，chain ID
`4663` / `0x122b`）上的 MySun rehearsal deployment。

> **尚未審計，也不是 production deployment；不要用於真實資金。** 本頁於 2026-10-27 透過公開 RPC
> 核對；核對時 RPC 回報區塊 `99,084,947`。Vault 的 `tokens()`、`adapters()` 與 EIP-1967
> implementation slot 以鏈上讀值為準。整合前請重新讀取，因為 proxy implementation 與 adapter 清單可能改變。

`shared/deployments.json` 是 frontend／keeper backend 使用的 chain、vault 與 periphery registry；本頁補充
token、adapter、executor 與 venue 地址。兩處重複欄位應保持一致。本頁只列整合所需地址，不列內部操作角色。

- Explorer：<https://robinhoodchain.blockscout.com>
- RPC：<https://robinhood.drpc.org>
- Network：Robinhood Chain mainnet — chain ID `4663`

## Tokens

| Token | Address | Decimals |
|---|---|---|
| PONS | `0x39dBED3a2bd333467115dE45665cC57F813C4571` | 18 |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | 6 |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | 18 |
| SPY | `0x117cc2133c37B721F49dE2A7a74833232B3B4C0C` | 18 |
| GLD | `0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e` | 18 |
| NVDA | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | 18 |
| SPCX | `0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa` | 18 |
| CRCL | `0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5` | 18 |
| TSLA | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` | 18 |
| AAPL | `0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9` | 18 |
| AMZN | `0x12f190a9F9d7D37a250758b26824B97CE941bF54` | 18 |
| INTC | `0xc72b96e0E48ecd4DC75E1e45396e26300BC39681` | 18 |
| MU | `0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD` | 18 |
| MSTR | `0xec262a75e413fAfD0dF80480274532C79D42da09` | 18 |

## Vaults

15 顆；其中 13 顆在 registry 標記 `"staging": true`（`sunTriLP` 與 12 顆股票 vault），在 MySun 網站
預設**不出現在 Markets、也不能用深連結開啟**，要輸入 team access code 才會顯示——這是前端顯示層的
軟性閘門，不是存取控制：地址、鏈上資料與本頁的內容對所有人都是公開的。`sunEthLP` 與 `sunPonsLP`
是預設可見的兩顆。

Receipt tokens 為 ERC-20、18 decimals；每個 vault 的 name／symbol 在初始化時設定。

### sunEthLP — basket `[USDG, WETH]`

- Vault (UUPS proxy): `0x6767257AAFfCE82f6ba4B6E96EDBa80e9e1112FC`
- Implementation（current EIP-1967 slot）：`0x1b8a02FeF41cAA651a6C275d859D1950e08605E8`
- Basket order（鏈上 `tokens()`）：`[USDG, WETH]`
- Adapters（鏈上 `adapters()` 順序；2026-10-19 移除 3 顆空的 V3 placeholder 後 → 6）：
  - `0xAdEC6dD17ecdaCB51676f745883a620CCf390Ab7` — V4 native-ETH（ETH/USDG）
  - `0xCC7A750507DCCDa8f76728Fb412BbAc6Ba04be7B` — V4 native-ETH（ETH/USDG）
  - `0xd06Ce50C9a57999ec225A4BC2215410b8A3c41e8` — V4 native-ETH（ETH/USDG）
  - `0x66181c9043d56C2A524192920e4F476E683E284e` — V4 native-ETH（ETH/USDG）
  - `0x282CaF98CFEB0B4cA624A39B8910248963b9D517` — V4 native-ETH（ETH/USDG）
  - `0x03B2FeE013D5A4769e2d44c9EB320dd8b3d74786` — V4 native-ETH（ETH/USDG）

### sunPonsLP — basket `[USDG, PONS]`

- Vault (UUPS proxy): `0x0621252C87307Ed4F07a644F1Ad3a7bb7340c35f`
- Implementation（current EIP-1967 slot）：`0x8bd16efce86b7bacd2c3d3184f6e10e0ad1c6f60`
- Basket order（鏈上 `tokens()`）：`[USDG, PONS]`
- DepositSplit helper（stateless）：`0xe4339d8787296AAf206C1590E4A909cCabE766C1`
- Adapters（鏈上 `adapters()` 順序；issue-8 換血後，2026-10-19；全 V4 hooked PONS/USDG）：
  - `0x04D9b0701d980D9d2cA779BDaa60240b0cFa0e75`
  - `0x62B0E69D798FeD6FCcEe98d5fa92371B585D6Da3`
  - `0xC5E09EC720758753B2f18329052b6B82fd2a6989`
  - `0xed152FD5a70981847c727B82447FFe05Cf72B388`
  - `0x7D2BD9F190026778C64CF9dd24B717D2b19e46a1`
  - `0xe431af961272C84E1F8c78396CA69BbAAF445Bd5`

### sunTriLP — basket `[USDG, WETH, PONS]`

- Vault (UUPS proxy): `0x4bbfd5c66e5df6cbebb3240027f9f8194bcebb98`
- Implementation（current EIP-1967 slot）：`0xfb2b8bb278ed4f794508fb1967be280dda03f020`
- Basket order（鏈上 `tokens()`）：`[USDG, WETH, PONS]`
- DepositSplit helper（stateless）：`0xe2fb4ad3751cacd756bccf5938e0d7b3bcd77a01`
- Adapters（鏈上 `adapters()` 順序；issue-8 換血後，2026-10-19；v4 全 FablesRamp 市場池）：
  - `0xFF484F98C018E541f4C27218597Ba7D12ED67210` — native-ETH（ETH/USDG）
  - `0xF9F883ca4B671a560D987E7d55997c98c7C4611d` — native-ETH（ETH/USDG）
  - `0x0bbDC0d9d892d0a590eDe11dFC6aEe38dC197727` — native-ETH（ETH/USDG）
  - `0x7C2FF6240Feb7634A56774DA72D68e67Ba27501e` — native-ETH（ETH/USDG）
  - `0x6469A4D085479422C3fFd471462B4BEa4fee82DD` — native-ETH（ETH/USDG）
  - `0x7f117DFdC555B40FF505D28D91ecB892111021f1` — native-ETH（ETH/USDG）
  - `0xfdFd5e885Dbd3bAC3997d45B8F629987e7C7b032` — native-ETH（ETH/USDG）
  - `0x8275Fe3A2B17D0099cB9e218EbBeA72724A595aA` — hooked（PONS/USDG）
  - `0xeECC49eb69aa1F85b37dc45cc3D0dA5265E8844e` — hooked（PONS/USDG）
  - `0xe90C772e2Ca3ee6bdce7B69764d596F99e91a2E5` — hooked（PONS/USDG）
  - `0x934Cf0BcA9438A706aCA5f396088bdD904c885e0` — hooked（PONS/USDG）
  - `0x8164200d30aD8e5435e56bDCCe6CbF1cd3cE1EbD` — hooked（PONS/USDG）
  - `0x0FB7a474ACC06D61B57cCE14d66a29E22E83188D` — hooked（PONS/USDG）
  - `0x6e606eCda979c774E7E90aD272f7F90dDE4b2A97` — native-ETH（ETH/PONS）
  - `0x6EBeeb97E36e599c273D0Bb2f0385980C6bc4294` — native-ETH（ETH/PONS）
  - `0x2CaF7Df4582e314fBb1539d1A09C175B7e6BbE1c` — native-ETH（ETH/PONS）
  - `0xEbF3d5C00F4bc03C7294BcE7564F4e3fF86553ec` — native-ETH（ETH/PONS）
  - `0xa7702970f9587be4E59948cB0993e0b450f0AAfE` — native-ETH（ETH/PONS）

### sunSpyLP — basket `[USDG, SPY]`

- Vault (UUPS proxy): `0x29F4b76F9C323C33A9348C47ECbEdce952486982`
- Implementation（current EIP-1967 slot）：`0x0c50081bD577f6DE15701D36eD758C7a4375cE80`
- Basket order（鏈上 `tokens()`）：`[USDG, SPY]`
- DepositSplit helper（stateless）：`0xe34121e727C154B51602aa1Ff7C0A55b47548422`
- PlanExecutor：`0xAcD58caC060182B173AD3C79e137c14A3815a84B`
- Adapters（鏈上 `adapters()` 順序；6 × V4 hooked，Fables 市場池 `0x8674c1c5544f3c9563565b5d4bd5916701d90b3559b072acf7cef5b4fc5b8dcd`）：
  - `0xCE2876b4aDDc88A7567Fa697344211888780bD45`
  - `0x16F30fc8A7A1188C781Ac6798aFA512d2F670B3B`
  - `0x77571941ba69156b14028C60648ff89D8Da77d21`
  - `0x2494CfAE39AeAe24b4D4E88F55a30D06AeDB0D8c`
  - `0x04C543E3517269aF55Af5A9f48CcE587d4d52c25`
  - `0xF2E1B58dA2f83F0Db878B2D5bc8be9aaa7830400`

### sunGldLP — basket `[USDG, GLD]`

- Vault (UUPS proxy): `0x93de7F559f7a701d2fb69137AEddB2BCc4EAD4B0`
- Implementation（current EIP-1967 slot）：`0x7f4Cd354f5d877fD3dE6FA38DC2f474f96D886F5`
- Basket order（鏈上 `tokens()`）：`[USDG, GLD]`
- DepositSplit helper（stateless）：`0x38F4ce73e7C80051ceAEC14b28Cbd3D399db27d1`
- PlanExecutor：`0x68B4fa690a4aB4435ACd25016b334ee5a14f1eA7`
- Adapters（鏈上 `adapters()` 順序；6 × V4 hooked，Fables 市場池 `0xfe281bbfa9aa658c1aa9c2ad1b0c62c4286f96c7cb1074296b54e869935a7a3a`）：
  - `0x08DDE898C732befA1BB51D1bD43bC258D6F77dF0`
  - `0x04857FD13fb9648272d3d8943AD8Cd5680a4247C`
  - `0x09d2A3F1fd6f42EBA67307D19D223a5b204D98d5`
  - `0x9234E9462c7ef5E0261188539E5927bB863E5DBe`
  - `0xE3f6d3FD73545100882F6C828f756EF4308aB157`
  - `0x75f9ac4a0fD0e8fA1836cE1670b05beD851A9c4F`

### sunNvdaLP — basket `[USDG, NVDA]`

- Vault (UUPS proxy): `0x1D43558214C5d1839a4C4326efbFAdc8BA5B29d3`
- Implementation（current EIP-1967 slot）：`0xAa0e97cc8F7351a2c1FfCE64d07e335E50003A1d`
- Basket order（鏈上 `tokens()`）：`[USDG, NVDA]`
- DepositSplit helper（stateless）：`0x7C206Ea8b825537401D27DED8312bF1330C97f3f`
- PlanExecutor：`0xe1fF9bB44879805A1E8bE0fEAf6a90E0fa74cDb3`
- Adapters（鏈上 `adapters()` 順序；6 × V4 hooked，Fables 市場池 `0x7990aad9e8fb048f49a155a7df5603db0366f0657035b78eb4196395cccb3dcd`）：
  - `0x90436e2887E44646C1C24078A7893e35ea5973a8`
  - `0xEdA2D89062EB3af72974C717a529Ef36f2873754`
  - `0xc494D7e264D6DE18E05d37a96DcB0FD4bd130b38`
  - `0x24A2976A5d5B180c23735296B7D8a066c0Bc529a`
  - `0x08dA24d492Bf5aD6242B9eA3D635e2BE2dAa07f6`
  - `0xA5d619FE0a58Ea40393cC8ACc78e4e847BBa720A`

### sunSpcxLP — basket `[USDG, SPCX]`

- Vault (UUPS proxy): `0xA3A853e38131aDf80b30595850CAd9b949764C46`
- Implementation（current EIP-1967 slot）：`0x4C5d660d2db4D42FB4971258fA75c1938F079B72`
- Basket order（鏈上 `tokens()`）：`[USDG, SPCX]`
- DepositSplit helper（stateless）：`0x1e11a5dD0a6cd4669Da651011A4302d92Fc3c31F`
- PlanExecutor：`0x19feDAA385e76C0edf256969e8000865aA3AeF90`
- Adapters（鏈上 `adapters()` 順序；6 × V4 hooked，Fables 市場池 `0xb81d873dfb2bb1aaf08804053f8940fd06bb30a2b5a0fafcdbcc7325544452b9`）：
  - `0xb8c370560Cd61EB7B9c9c632d43a0F76115E1Fc6`
  - `0x368d0c9059968a4F357B93B2eCFc5dD04C79B6ee`
  - `0x2Bf051aDee1ad8BBd865aF898cc117FE6B51b774`
  - `0x1EF05cA7d4e85C101a53198beAf7A55E84c24D31`
  - `0xE85b16c20f48867aC1Ae3Eff26fA679b4cEd1bfE`
  - `0x6C9B374dE9d5dC65A4F78bC3b2F1c0205e244415`

### sunCrclLP — basket `[USDG, CRCL]`

- Vault (UUPS proxy): `0xF9FBF933a42f1741f725b3585468A08b3ae51C29`
- Implementation（current EIP-1967 slot）：`0xc286cE4B642748Cd70c654a58Fe7277B586157b1`
- Basket order（鏈上 `tokens()`）：`[USDG, CRCL]`
- DepositSplit helper（stateless）：`0xFC3BBE14b133913345014a7f563A6A8ab68fFE3B`
- PlanExecutor：`0x7C6c2A9616c189916F803986C5Df58a12C62555D`
- Adapters（鏈上 `adapters()` 順序；6 × V4 hooked，Fables 市場池 `0xdb9c34002d173981250969293af6f43f42a26f2110f19893bbe2ad373375e9e6`）：
  - `0x40eef111289c2D9857866e895267b257fd2B9a0C`
  - `0xBB3e7E2B4A12F9E0ad82CA2da82F8a7b1722F99E`
  - `0x06f3AFaf2F65790FC53c33927Ea9104ad4E99219`
  - `0xF761f554ae443e8CC4c0251A43586534D506b796`
  - `0x687f1052643d648246ba1324f932574a56C13792`
  - `0x0A806EEc473093FF8635f9bc4F6CF79615019A35`

### sunTslaLP — basket `[USDG, TSLA]`

- Vault (UUPS proxy): `0x1a6282593c3D4D48315F4730140f9B82A7cD9034`
- Implementation（current EIP-1967 slot）：`0xF57903c2C603c4334dB6Ba39678c1976BDec7b56`
- Basket order（鏈上 `tokens()`）：`[USDG, TSLA]`
- DepositSplit helper（stateless）：`0xD62EDd5b190fF60f5DFE4DDf83bD96D6e13CD633`
- PlanExecutor：`0x0569a9185c55eeb926076924bc13bC8d0C4072A1`
- Adapters（鏈上 `adapters()` 順序；6 × V4 hooked，Fables 市場池 `0xd5effce87036cd858146c0c15fa825c231a9de1843200ca108e431e431331e8e`）：
  - `0x63EC43995e74027Bb7732106b2fd93053777647A`
  - `0x04a827c73f3cFd606b8F9c51c086f77c60B94F00`
  - `0x3c6990891E7f60963597E3030AeC5D8D3e8ED972`
  - `0xF9ED9fe278E1344afFfa69E9F91a82B436236bd1`
  - `0xe4cEA10A8C04B1AE9b3bC87596E42286dEC5dc24`
  - `0xb90B9F42814d78d33C0E8dC8f904637ba2c9568b`

### sunAaplLP — basket `[USDG, AAPL]`

- Vault (UUPS proxy): `0x95C812AD13442B6B57187EF0895eaF7065853711`
- Implementation（current EIP-1967 slot）：`0x46E5DA2122C1A1692206b01207a3CB78F9ab4DCA`
- Basket order（鏈上 `tokens()`）：`[USDG, AAPL]`
- DepositSplit helper（stateless）：`0xBc26C1b182e126F8F28F6DFE42a1f2Ed87Eb0D62`
- PlanExecutor：`0x983e8aD59D9D260A4BaD21D75e7E7D5bdB878094`
- Adapters（鏈上 `adapters()` 順序；6 × V4 hooked，Fables 市場池 `0xa2347ba69167e5602f74640ffbf737ee7cdd825e4726d3462564fc6533070147`）：
  - `0xC7337F7cBcCE14f7936b40CdC01E0DEf8461547D`
  - `0x6925892e22beF1152e6F785BAacAE6688193A6e1`
  - `0xf08eC5f132B196b1c7183df6a1192967Fd4DD08D`
  - `0xC57C7c55778Fccc0BDFF1271A63F15b5d78101bF`
  - `0x555Ff30cab5C488F870261439f3e1941110D94DA`
  - `0x17e7513a12e328791C2d361cB11DE5374Dc36E2b`

### sunAmznLP — basket `[USDG, AMZN]`

- Vault (UUPS proxy): `0x2818D2195Ec6F589D054eC9a8A8cFee18E28e550`
- Implementation（current EIP-1967 slot）：`0x80dd0Dd67A5eDA3Be9Aa7aFd26C558cA7De41dc3`
- Basket order（鏈上 `tokens()`）：`[USDG, AMZN]`
- DepositSplit helper（stateless）：`0xDA94906ab69830E888d71A7e75B460aeE3f87904`
- PlanExecutor：`0xB38848C1A03846f2930ab91Ae52CE8dD6F6Ff0a2`
- Adapters（鏈上 `adapters()` 順序；6 × V4 hooked，Fables 市場池 `0x5619cb8420678b47997f20925eb01be8750c907d6226a0df5d7eafeff966346f`）：
  - `0x82e42c154560862e89F8272A80d5C4ddf45E29e8`
  - `0x51FfF22480e649b7340178F102438c71Fe870bb6`
  - `0xf998602688E91197A212AE33BC90A36372869378`
  - `0x6EfF81e7dCd573cac295044d51c2b8eDB2389185`
  - `0x3A8B26a27015374F660b77BC53376f23efcBB814`
  - `0x7a96c78fFf0491c2381CE6e39887DFf5E7162E8e`

### sunIntcLP — basket `[USDG, INTC]`

- Vault (UUPS proxy): `0x3EFD9AbA9F749E05f070eEBD69477ef777AbF91E`
- Implementation（current EIP-1967 slot）：`0x3F83a32F6b32C0F9c80403a6B5B31ef8AEd7F894`
- Basket order（鏈上 `tokens()`）：`[USDG, INTC]`
- DepositSplit helper（stateless）：`0xE96bACD8c1306F1038b1F668D6bC3C0b3A4CDdd8`
- PlanExecutor：`0x65F8faa2C111E5648feED6bbFaC1EF9296023c42`
- Adapters（鏈上 `adapters()` 順序；6 × V4 hooked，Fables 市場池 `0x5e4c353496e4c82a406a38ca1eaad6d2d4cdb8d405d422faff84bcb6f548d97e`）：
  - `0x0FfB6D74c14289a931bbC7c6997EC0178084D628`
  - `0xC8e784fCCbc24Bd343C16fA3478d2Ab383Ae2e4d`
  - `0xCBD272e3Ce05aF14B1e904433836a2B8eAcA6c4a`
  - `0x1a69313EDf7bec3C244b856f4977c27abd125AE5`
  - `0xAae31fAC3F94EDDe8cE862D47c054389a75d7f06`
  - `0x02015a7F2AAf396D516A26DF36f15DB44753Daa5`

### sunMuLP — basket `[USDG, MU]`

- Vault (UUPS proxy): `0x424a85C4c9B427e767b7E9E6F519E6660f0AD56e`
- Implementation（current EIP-1967 slot）：`0x802b8111f2B63118DD7d6cd875f2f5313753f934`
- Basket order（鏈上 `tokens()`）：`[USDG, MU]`
- DepositSplit helper（stateless）：`0x1970fbE4840C770879A771c18A278ACdEc2f03c8`
- PlanExecutor：`0xCE938B93b902ea9f72507cF6a9f4E411E4e766f6`
- Adapters（鏈上 `adapters()` 順序；6 × V4 hooked，Fables 市場池 `0x8e36bc9877b9383ae306dd937d40ab0e9df65811e7fdfb6bad25e7102bc398b2`）：
  - `0x841799E6E7c5114621a30084da1a2473BB26AeAD`
  - `0xdD5F095AF97a75144180225660FBc45622A822EC`
  - `0x0fc1ee723F6fF09F9f75C1d2E2e0fF10E285C4f8`
  - `0xdd6f741eE096AF838db0c5EDAC25F4543C303c69`
  - `0x68852251D29a90BD443907425d2badC5A73a29A5`
  - `0x8300081AFd13f2a7484c20E1187C655fEc7c6D28`

### sunMstrLP — basket `[USDG, MSTR]`

- Vault (UUPS proxy): `0x444a71032DE298b4c26e6e699E74Ee9c84bA525C`
- Implementation（current EIP-1967 slot）：`0x5D9950b871Be197E2C57629B808C77a706b47EDe`
- Basket order（鏈上 `tokens()`）：`[USDG, MSTR]`
- DepositSplit helper（stateless）：`0x1Dc84E6E9F3EDFa598744e56B8Be4CF2D6A05B5D`
- PlanExecutor：`0xa5B9A68812374B49A9eA82c5a33cEF0A61bbEbe2`
- Adapters（鏈上 `adapters()` 順序；6 × V4 hooked，Fables 市場池 `0xe1c3e133c917674bd51704e47c7dfe7f0d66375c89ceb30b083de95f9a1dc5ea`）：
  - `0x8eE919265d2CC9D6651Ab64e8b55c5135146E823`
  - `0xa18ebdAb0fe58800d961237d1C2332E183C5C9bb`
  - `0xA5A897ae23d6221de1ec6d6d3E2c8F06b7c75e18`
  - `0x312176d915585E3C4f4Ef518AB3bB123CD85A227`
  - `0x34622dcD2Dfb0B8Ef56C6c179F3534E94B2E11C7`
  - `0xe69B4832DF589513E3e3042A1BEA411eab769111`

### sunNvdaSpyLP — basket `[SPY, NVDA]`

- Vault (UUPS proxy): `0x2184A0558E63d2484d2f63d933A95709c9E583E0`
- Implementation（current EIP-1967 slot）：`0x66E8719Cd54254E099513430B10E243ea3F5bB4D`
- Basket order（鏈上 `tokens()`）：`[SPY, NVDA]`
- DepositSplit helper（stateless）：`0x313FB0499D077544999C6C1AaADf4F67832B5e9f`
- PlanExecutor：`0x253414a4401621253413813415910Bce05FEDeb1`
- Adapters（鏈上 `adapters()` 順序；6 × V4 hooked，Fables 市場池 `0x988f3b6ceec4795e0d6d28a054af87ffbcbdeee2566f72ae391da5f109bd485f`）：
  - `0x7ec06785544D939db1d1A55538821Ca7c2C052d7`
  - `0xBF4b83D6baA94de2DFfd4A3b73aeC98a0432Bd18`
  - `0x760f2d9f0F1D3dc9Acd6d019E6791ebF0bf7C5A2`
  - `0x97b89Ddb8ec5516Bf2Bfb8dcB7838b7E939C41E1`
  - `0x7Db5d98e78768aa78A8E49Ddb8768e2F902C713f`
  - `0x4c50b2904709516B44F5dEA533272bae64483402`

## Periphery

| Artifact | Address |
|---|---|
| ZapIn (USDG-only deposits) | `0x8187691738907dCCBB34f6Aa82059CCF1Ae3870f` |
| ZapOut (single-token exits) | `0xd9151216e2Ab52b446aAb0207Ab34652b44D228C` |
| PlanExecutor (keeper plans) | `0xbE744F7685bd7fa6365B6519CE66DeDa71873139` (sunEthLP); sunPonsLP `0x792Efc2e0D59679390742203F664c67F9D02F8cA`; sunTriLP `0x4d6a45Aa30c2832bB88c9a24bBdD3aCAD7f1b31F` |
| Swap Executor (ERC-20, UniversalRouter) | `0x413a67ca4E83A4782F7745858979fE059ccbB431` |
| Native Swap Executor (v4 native) | `0x58452cf80a0819a75a3b94347f706280ccc03d04` |

## Venue & infrastructure

| Artifact | Address / ID |
|---|---|
| PoolManager (v4) | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| PositionManager (POSM, v4) | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` |
| Uniswap V3 Factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| FablesRamp hook — ETH/USDG | `0x06a889870C8f83640D6816319f72e2aA579b6080` |
| FablesRamp hook — PONS/USDG | `0x08E52564Bad99E05a694b4809F397edcA417A080` |
| V4 pool id — ETH/USDG | `0xbac3aa3b91584a53a579b3c999a56756e954e59247e497bad1d25a4334bde551` |
| V4 pool id — PONS/USDG | `0x486435a1f76cd58193f854c6e6213cd05fd58d637865d02065ff558b387fa6ea` |
| Fables hook — USDG/SPY | `0xA0E8fBFf13E24Af2b5e61A72800E08a161bDe080` |
| V4 pool id — USDG/SPY | `0x8674c1c5544f3c9563565b5d4bd5916701d90b3559b072acf7cef5b4fc5b8dcd` |
| Fables hook — USDG/GLD | `0xB608a78761f179f7C56f15E7D13921B92F00a080` |
| V4 pool id — USDG/GLD | `0xfe281bbfa9aa658c1aa9c2ad1b0c62c4286f96c7cb1074296b54e869935a7a3a` |
| Fables hook — USDG/NVDA | `0x66622f77B797D506e5376F7798b67ab288966080` |
| V4 pool id — USDG/NVDA | `0x7990aad9e8fb048f49a155a7df5603db0366f0657035b78eb4196395cccb3dcd` |
| Fables hook — USDG/SPCX | `0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080` |
| V4 pool id — USDG/SPCX | `0xb81d873dfb2bb1aaf08804053f8940fd06bb30a2b5a0fafcdbcc7325544452b9` |
| Fables hook — USDG/CRCL | `0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080` |
| V4 pool id — USDG/CRCL | `0xdb9c34002d173981250969293af6f43f42a26f2110f19893bbe2ad373375e9e6` |
| Fables hook — USDG/TSLA | `0x67D86050d22D574Df046F3D90F722045F714e080` |
| V4 pool id — USDG/TSLA | `0xd5effce87036cd858146c0c15fa825c231a9de1843200ca108e431e431331e8e` |
| Fables hook — USDG/AAPL | `0x70a9A88402989226847Ec122043CE5e7FF462080` |
| V4 pool id — USDG/AAPL | `0xa2347ba69167e5602f74640ffbf737ee7cdd825e4726d3462564fc6533070147` |
| Fables hook — USDG/AMZN | `0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080` |
| V4 pool id — USDG/AMZN | `0x5619cb8420678b47997f20925eb01be8750c907d6226a0df5d7eafeff966346f` |
| Fables hook — USDG/INTC | `0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080` |
| V4 pool id — USDG/INTC | `0x5e4c353496e4c82a406a38ca1eaad6d2d4cdb8d405d422faff84bcb6f548d97e` |
| Fables hook — USDG/MU | `0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080` |
| V4 pool id — USDG/MU | `0x8e36bc9877b9383ae306dd937d40ab0e9df65811e7fdfb6bad25e7102bc398b2` |
| Fables hook — USDG/MSTR | `0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080` |
| V4 pool id — USDG/MSTR | `0xe1c3e133c917674bd51704e47c7dfe7f0d66375c89ceb30b083de95f9a1dc5ea` |
| Fables hook — SPY/NVDA | `0x79576FBAD6e83915630BBB5D5658483F05532080` |
| V4 pool id — SPY/NVDA | `0x988f3b6ceec4795e0d6d28a054af87ffbcbdeee2566f72ae391da5f109bd485f` |

## 整合注意事項

- 對 vault 互動請使用 **proxy address**；implementation 只供核對，升級後可能更換。
- Basket token 順序以鏈上 `tokens()` 為準，不要依 UI 標籤自行假設。
- `shared/deployments.json` 提供 app 使用的 chain、vault 與 periphery 設定；本頁補充 adapter、token 與 venue 地址。
- 本頁不列本機 demo chain（46630）的地址；其 RPC 是本機端點，demo stack 也可能重新部署。