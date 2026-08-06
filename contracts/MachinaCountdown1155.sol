// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC165 { function supportsInterface(bytes4 interfaceId) external view returns (bool); }
interface IERC1155Receiver is IERC165 {
    function onERC1155Received(address operator,address from,uint256 id,uint256 value,bytes calldata data) external returns (bytes4);
    function onERC1155BatchReceived(address operator,address from,uint256[] calldata ids,uint256[] calldata values,bytes calldata data) external returns (bytes4);
}
interface IERC1155 is IERC165 {
    event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value);
    event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values);
    event ApprovalForAll(address indexed account,address indexed operator,bool approved);
    event URI(string value,uint256 indexed id);
    function balanceOf(address account,uint256 id) external view returns (uint256);
    function balanceOfBatch(address[] calldata accounts,uint256[] calldata ids) external view returns (uint256[] memory);
    function setApprovalForAll(address operator,bool approved) external;
    function isApprovedForAll(address account,address operator) external view returns (bool);
    function safeTransferFrom(address from,address to,uint256 id,uint256 amount,bytes calldata data) external;
    function safeBatchTransferFrom(address from,address to,uint256[] calldata ids,uint256[] calldata amounts,bytes calldata data) external;
}
interface IERC1155MetadataURI is IERC1155 { function uri(uint256 id) external view returns (string memory); }

library MachinaBase64 {
    bytes internal constant TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    function encode(bytes memory data) internal pure returns (string memory) {
        if (data.length == 0) return "";
        uint256 len = 4 * ((data.length + 2) / 3);
        bytes memory result = new bytes(len);
        uint256 i; uint256 j;
        while (i < data.length) {
            uint256 a = uint8(data[i++]);
            uint256 b = i < data.length ? uint8(data[i++]) : 0;
            uint256 c = i < data.length ? uint8(data[i++]) : 0;
            uint256 chunk = (a << 16) | (b << 8) | c;
            result[j++] = TABLE[(chunk >> 18) & 63];
            result[j++] = TABLE[(chunk >> 12) & 63];
            result[j++] = TABLE[(chunk >> 6) & 63];
            result[j++] = TABLE[chunk & 63];
        }
        uint256 r = data.length % 3;
        if (r == 1) { result[len-1] = "="; result[len-2] = "="; }
        else if (r == 2) result[len-1] = "=";
        return string(result);
    }
}

contract MachinaCountdown1155 is IERC1155MetadataURI {
    uint8 public constant TOTAL_DAYS = 40;
    uint8 public constant METADATA_VERSION = 5;
    string public constant name = "Arc Mainnet Countdown";
    string public constant symbol = "ARC40";

    address public owner;
    uint64 public immutable startTime;
    bool public immutable testMode;
    uint8 public testDay;
    uint256 public totalSupply;
    string private machinaHeadPngB64;

    mapping(uint256 => mapping(address => uint256)) private balances;
    mapping(address => mapping(address => bool)) private operatorApprovals;
    mapping(address => uint256) public claimedBitmap;
    mapping(address => uint8) public claimedCount;

    event OwnershipTransferred(address indexed previousOwner,address indexed newOwner);
    event DailyClaim(address indexed wallet,uint8 indexed day,uint256 indexed tokenId);
    event TestDayChanged(uint8 indexed day);
    event SmokeDayReset(address indexed wallet,uint8 indexed day);

    modifier onlyOwner(){ require(msg.sender == owner,"Not owner"); _; }

    constructor(string memory embeddedHeadPngB64,uint64 campaignStartTime,bool enableTestMode){
        require(bytes(embeddedHeadPngB64).length > 100,"Head artwork missing");
        owner = msg.sender;
        machinaHeadPngB64 = embeddedHeadPngB64;
        startTime = campaignStartTime;
        testMode = enableTestMode;
        if (enableTestMode) testDay = 1;
        emit OwnershipTransferred(address(0),msg.sender);
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns(bool){
        return interfaceId == 0x01ffc9a7 || interfaceId == 0xd9b67a26 || interfaceId == 0x0e89341c;
    }

    function contractURI() external view returns(string memory){
        string memory json = string.concat(
            '{"name":"Arc Mainnet Countdown","description":"Independent Machina community countdown to Arc Mainnet. Collect one daily participation NFT and build a 40-day wallet record.","image":"',
            _tokenImage(40), '"}'
        );
        return string.concat("data:application/json;base64,",MachinaBase64.encode(bytes(json)));
    }

    function uri(uint256 id) external view override returns(string memory){
        require(id >= 1 && id <= TOTAL_DAYS,"Invalid token id");
        string memory day = _toString(id);
        string memory padded = id < 10 ? string.concat("0",day) : day;
        string memory title = _title(id);
        string memory json = string.concat(
            '{"name":"Arc Mainnet Countdown - Day ',padded,
            '","description":"Day ',day,
            ' of the 40-day Arc Mainnet countdown. This NFT records participation by the holder wallet.","image":"',_tokenImage(id),
            '","attributes":[{"trait_type":"Day","value":',day,
            '},{"trait_type":"Total Days","value":40},{"trait_type":"Signal","value":"',title,
            '"},{"trait_type":"Network","value":"Arc Testnet"}]}'
        );
        return string.concat("data:application/json;base64,",MachinaBase64.encode(bytes(json)));
    }

    function balanceOf(address account,uint256 id) public view override returns(uint256){ require(account != address(0),"Zero address"); return balances[id][account]; }
    function balanceOfBatch(address[] calldata accounts,uint256[] calldata ids) external view override returns(uint256[] memory result){
        require(accounts.length == ids.length,"Length mismatch"); result = new uint256[](accounts.length);
        for(uint256 i=0;i<accounts.length;i++) result[i]=balanceOf(accounts[i],ids[i]);
    }
    function setApprovalForAll(address operator,bool approved) external override { require(operator != msg.sender,"Self approval"); operatorApprovals[msg.sender][operator]=approved; emit ApprovalForAll(msg.sender,operator,approved); }
    function isApprovedForAll(address account,address operator) public view override returns(bool){ return operatorApprovals[account][operator]; }
    function safeTransferFrom(address from,address to,uint256 id,uint256 amount,bytes calldata data) external override { require(from==msg.sender || isApprovedForAll(from,msg.sender),"Not approved"); _transfer(from,to,id,amount,data); }
    function safeBatchTransferFrom(address from,address to,uint256[] calldata ids,uint256[] calldata amounts,bytes calldata data) external override {
        require(from==msg.sender || isApprovedForAll(from,msg.sender),"Not approved"); require(ids.length==amounts.length,"Length mismatch"); require(to!=address(0),"Zero address");
        for(uint256 i=0;i<ids.length;i++){ uint256 bal=balances[ids[i]][from]; require(bal>=amounts[i],"Insufficient balance"); balances[ids[i]][from]=bal-amounts[i]; balances[ids[i]][to]+=amounts[i]; }
        emit TransferBatch(msg.sender,from,to,ids,amounts); _checkBatchReceiver(msg.sender,from,to,ids,amounts,data);
    }

    function currentDay() public view returns(uint8){
        if(testMode && testDay!=0) return testDay;
        if(block.timestamp < startTime) return 0;
        uint256 elapsed=(block.timestamp-startTime)/1 days;
        if(elapsed>=TOTAL_DAYS) return TOTAL_DAYS+1;
        return uint8(elapsed+1);
    }
    function hasClaimed(address wallet,uint8 day) public view returns(bool){ if(day==0 || day>TOTAL_DAYS) return false; return (claimedBitmap[wallet] & (uint256(1) << (day-1))) != 0; }
    function claim() external {
        uint8 day=currentDay(); require(day>=1 && day<=TOTAL_DAYS,"Claim window closed"); require(!hasClaimed(msg.sender,day),"Already claimed");
        claimedBitmap[msg.sender] |= uint256(1) << (day-1); claimedCount[msg.sender]+=1; _mint(msg.sender,uint256(day),1,""); emit DailyClaim(msg.sender,day,uint256(day));
    }
    function eligibilityTier(address wallet) external view returns(uint8){ uint8 count=claimedCount[wallet]; if(count>=40)return 40; if(count>=30)return 30; if(count>=20)return 20; return 0; }
    function claimedDays(address wallet) external view returns(uint8[] memory dayList){ uint8 count=claimedCount[wallet]; dayList=new uint8[](count); uint256 cursor; for(uint8 day=1;day<=TOTAL_DAYS;day++){ if(hasClaimed(wallet,day)) dayList[cursor++]=day; } }
    function setTestDay(uint8 day) external onlyOwner { require(testMode,"Test mode disabled"); require(day>=1 && day<=TOTAL_DAYS,"Invalid day"); testDay=day; emit TestDayChanged(day); }
    function resetSmokeDay(address wallet,uint8 day) external onlyOwner { require(testMode,"Test mode disabled"); require(day>=1 && day<=TOTAL_DAYS,"Invalid day"); require(hasClaimed(wallet,day),"Day not claimed"); claimedBitmap[wallet] &= ~(uint256(1) << (day-1)); claimedCount[wallet]-=1; _burn(wallet,uint256(day),1); emit SmokeDayReset(wallet,day); }
    function transferOwnership(address newOwner) external onlyOwner { require(newOwner!=address(0),"Zero address"); address previous=owner; owner=newOwner; emit OwnershipTransferred(previous,newOwner); }

    function _mint(address to,uint256 id,uint256 amount,bytes memory data) internal { require(to!=address(0),"Zero address"); balances[id][to]+=amount; totalSupply+=amount; emit TransferSingle(msg.sender,address(0),to,id,amount); emit URI(this.uri(id),id); _checkReceiver(msg.sender,address(0),to,id,amount,data); }
    function _burn(address from,uint256 id,uint256 amount) internal { uint256 bal=balances[id][from]; require(bal>=amount,"Insufficient balance"); balances[id][from]=bal-amount; totalSupply-=amount; emit TransferSingle(msg.sender,from,address(0),id,amount); }
    function _transfer(address from,address to,uint256 id,uint256 amount,bytes memory data) internal { require(to!=address(0),"Zero address"); uint256 bal=balances[id][from]; require(bal>=amount,"Insufficient balance"); balances[id][from]=bal-amount; balances[id][to]+=amount; emit TransferSingle(msg.sender,from,to,id,amount); _checkReceiver(msg.sender,from,to,id,amount,data); }

    function _tokenImage(uint256 id) private view returns(string memory){
        string memory svg = _tokenSvg(id);
        return string.concat("data:image/svg+xml;base64,",MachinaBase64.encode(bytes(svg)));
    }

    function _tokenSvg(uint256 id) private view returns(string memory){
        string memory day = _toString(id);
        string memory padded = id < 10 ? string.concat("0",day) : day;
        string memory title = _upper(_title(id));
        string memory subtitle = _subtitle(id);
        string memory phase = id <= 10 ? "SIGNAL" : id <= 20 ? "FLOW" : id <= 30 ? "SETTLEMENT" : "IGNITION";
        string memory ring = _ring(id);
        string memory bars = _bars(id);
        string memory top = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1100" viewBox="0 0 800 1100"><defs>',
            '<pattern id="n" width="5" height="5" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.6" fill="#26362c"/></pattern>',
            '<radialGradient id="core"><stop offset="0" stop-color="#15371c"/><stop offset="1" stop-color="#010503"/></radialGradient>',
            '<filter id="g" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>',
            '<clipPath id="c"><circle cx="400" cy="515" r="142"/></clipPath></defs>',
            '<rect width="800" height="1100" rx="46" fill="#252e29"/><rect x="9" y="9" width="782" height="1082" rx="38" fill="#050a07" stroke="#536159" stroke-width="3"/>',
            '<rect x="20" y="20" width="760" height="1060" rx="31" fill="url(#n)" stroke="#27332c" stroke-width="2"/>',
            '<path d="M42 70V42H126M674 42H758V70M42 1030V1058H126M674 1058H758V1030" fill="none" stroke="#69766e" stroke-width="2"/>',
            '<text x="64" y="82" fill="#8bf15a" font-family="Arial,sans-serif" font-size="22" font-weight="700" letter-spacing="6">ARC MAINNET COUNTDOWN</text>',
            '<text x="64" y="145" fill="#d7ded9" font-family="Arial,sans-serif" font-size="24" letter-spacing="6">DAY</text>',
            '<text x="62" y="242" fill="#fff" font-family="Arial,sans-serif" font-size="100" font-weight="300">',padded,'</text>',
            '<text x="64" y="292" fill="#cbd4ce" font-family="Arial,sans-serif" font-size="34">/ 40</text>',
            '<rect x="590" y="62" width="146" height="52" rx="26" fill="#102718" stroke="#4e7e58" stroke-width="2"/><text x="663" y="95" text-anchor="middle" fill="#bafc9a" font-family="Arial,sans-serif" font-size="17" font-weight="700" letter-spacing="2">',phase,'</text>',
            '<circle cx="400" cy="515" r="226" fill="none" stroke="#19241e" stroke-width="2"/>',ring,
            '<circle cx="400" cy="515" r="153" fill="url(#core)" stroke="#415c4b" stroke-width="3"/><path d="M400 382 L530 625 L270 625 Z" fill="none" stroke="#4eca23" stroke-width="5"/>',
            '<g clip-path="url(#c)"><image href="data:image/png;base64,',machinaHeadPngB64,'" x="270" y="385" width="260" height="260" preserveAspectRatio="xMidYMid meet"/></g>'
        );
        string memory bottom = string.concat(
            '<line x1="64" y1="790" x2="736" y2="790" stroke="#263129" stroke-width="2"/>',
            '<text x="400" y="866" text-anchor="middle" fill="#fff" font-family="Arial,sans-serif" font-size="44" font-weight="600">',title,'</text>',
            '<text x="400" y="920" text-anchor="middle" fill="#9facb4" font-family="Arial,sans-serif" font-size="25">',subtitle,'</text>',
            '<line x1="64" y1="972" x2="736" y2="972" stroke="#263129" stroke-width="2"/>',bars,
            '<text x="736" y="1028" text-anchor="end" fill="#9da9b3" font-family="Arial,sans-serif" font-size="14" font-weight="700" letter-spacing="3">DAY ',padded,' / 40</text></svg>'
        );
        return string.concat(top,bottom);
    }

    function _ring(uint256 day) private pure returns(string memory out){
        for(uint256 i=0;i<40;i++){
            string memory active = i < day ? '#7cf03e' : '#27312b';
            string memory glow = i < day ? ' filter="url(#g)"' : '';
            out = string.concat(out,'<rect x="396" y="292" width="8" height="32" rx="4" fill="',active,'" transform="rotate(',_toString(i*9),' 400 515)"',glow,'/>');
        }
    }
    function _bars(uint256 day) private pure returns(string memory out){
        uint256 activeBars = (day + 4) / 5;
        for(uint256 i=0;i<8;i++){
            string memory fill = i < activeBars ? '#77ef38' : '#202923';
            out = string.concat(out,'<rect x="',_toString(64+i*42),'" y="1018" width="29" height="7" rx="3.5" fill="',fill,'"/>');
        }
    }
    function _title(uint256 id) private pure returns(string memory){
        if(id==1)return "First Signal"; if(id==2)return "Boot Sequence"; if(id==3)return "Green Pulse"; if(id==4)return "Relay Online"; if(id==5)return "Vector Lock"; if(id==6)return "Machine Heart"; if(id==7)return "Proof of Motion"; if(id==8)return "Route Found"; if(id==9)return "Channel Open"; if(id==10)return "Network Pulse";
        if(id==11)return "Flow State"; if(id==12)return "Stable Current"; if(id==13)return "Liquidity Thread"; if(id==14)return "Crosschain Echo"; if(id==15)return "Packet Forward"; if(id==16)return "Deterministic"; if(id==17)return "Settlement Beam"; if(id==18)return "Finality Mark"; if(id==19)return "Threshold Near"; if(id==20)return "Threshold";
        if(id==21)return "Engine Sync"; if(id==22)return "Route Matrix"; if(id==23)return "Signal Mesh"; if(id==24)return "Chain Link"; if(id==25)return "Liquidity Route"; if(id==26)return "Proof Layer"; if(id==27)return "Relay Core"; if(id==28)return "State Verified"; if(id==29)return "Forward Motion"; if(id==30)return "Final Approach";
        if(id==31)return "Ignition Key"; if(id==32)return "Mainnet Vector"; if(id==33)return "Launch Window"; if(id==34)return "Orbit Locked"; if(id==35)return "Systems Ready"; if(id==36)return "Signal Six"; if(id==37)return "Signal Five"; if(id==38)return "Signal Four"; if(id==39)return "Last Orbit"; return "Mainnet Ignition";
    }
    function _subtitle(uint256 id) private pure returns(string memory){
        if(id==1)return "The journey begins."; if(id==2)return "Systems come online."; if(id==3)return "The network wakes."; if(id==4)return "The first route opens."; if(id==5)return "Direction confirmed."; if(id==6)return "Core systems active."; if(id==7)return "Momentum is visible."; if(id==8)return "A path is established."; if(id==9)return "Value can now move."; if(id==10)return "The network responds.";
        if(id==20)return "Mainnet eligibility begins."; if(id==30)return "We are getting closer."; if(id==40)return "The future is onchain."; return "Progress recorded onchain.";
    }
    function _upper(string memory value) private pure returns(string memory){ bytes memory s=bytes(value); for(uint256 i=0;i<s.length;i++){ uint8 c=uint8(s[i]); if(c>=97&&c<=122)s[i]=bytes1(c-32); } return string(s); }
    function _toString(uint256 value) private pure returns(string memory){ if(value==0)return "0"; uint256 temp=value; uint256 digits; while(temp!=0){digits++;temp/=10;} bytes memory buffer=new bytes(digits); while(value!=0){digits--;buffer[digits]=bytes1(uint8(48+value%10));value/=10;} return string(buffer); }

    function _checkReceiver(address operator,address from,address to,uint256 id,uint256 amount,bytes memory data) private { if(to.code.length==0)return; try IERC1155Receiver(to).onERC1155Received(operator,from,id,amount,data) returns(bytes4 response){ require(response==IERC1155Receiver.onERC1155Received.selector,"Rejected"); } catch { revert("Unsafe receiver"); } }
    function _checkBatchReceiver(address operator,address from,address to,uint256[] calldata ids,uint256[] calldata amounts,bytes calldata data) private { if(to.code.length==0)return; try IERC1155Receiver(to).onERC1155BatchReceived(operator,from,ids,amounts,data) returns(bytes4 response){ require(response==IERC1155Receiver.onERC1155BatchReceived.selector,"Rejected"); } catch { revert("Unsafe receiver"); } }
}
