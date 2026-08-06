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
    uint8 public constant METADATA_VERSION = 4;
    string public constant name = "Arc Mainnet Countdown";
    string public constant symbol = "ARC40";

    address public owner;
    uint64 public immutable startTime;
    bool public immutable testMode;
    uint8 public testDay;
    uint256 public totalSupply;
    string public imageBaseUrl;

    mapping(uint256 => mapping(address => uint256)) private balances;
    mapping(address => mapping(address => bool)) private operatorApprovals;
    mapping(address => uint256) public claimedBitmap;
    mapping(address => uint8) public claimedCount;

    event OwnershipTransferred(address indexed previousOwner,address indexed newOwner);
    event DailyClaim(address indexed wallet,uint8 indexed day,uint256 indexed tokenId);
    event TestDayChanged(uint8 indexed day);
    event SmokeDayReset(address indexed wallet,uint8 indexed day);
    event ImageBaseUrlChanged(string value);

    modifier onlyOwner(){ require(msg.sender == owner,"Not owner"); _; }

    constructor(string memory initialImageBaseUrl,uint64 campaignStartTime,bool enableTestMode){
        owner = msg.sender;
        imageBaseUrl = initialImageBaseUrl;
        startTime = campaignStartTime;
        testMode = enableTestMode;
        if (enableTestMode) testDay = 1;
        emit OwnershipTransferred(address(0),msg.sender);
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns(bool){
        return interfaceId == 0x01ffc9a7 || interfaceId == 0xd9b67a26 || interfaceId == 0x0e89341c;
    }

    function contractURI() external view returns(string memory){
        string memory image = string.concat(imageBaseUrl,"?id=40");
        string memory json = string.concat(
            '{"name":"Arc Mainnet Countdown","description":"Independent Machina community countdown to Arc Mainnet. Collect one daily participation NFT and build a 40-day wallet record.","image":"',
            image,'"}'
        );
        return string.concat("data:application/json;base64,",MachinaBase64.encode(bytes(json)));
    }

    function uri(uint256 id) external view override returns(string memory){
        require(id >= 1 && id <= TOTAL_DAYS,"Invalid token id");
        string memory day = _toString(id);
        string memory padded = id < 10 ? string.concat("0",day) : day;
        string memory title = _title(id);
        string memory image = string.concat(imageBaseUrl,"?id=",day,"&v=4");
        string memory json = string.concat(
            '{"name":"Arc Mainnet Countdown - Day ',padded,
            '","description":"Day ',day,
            ' of the 40-day Arc Mainnet countdown. This NFT records participation by the holder wallet.","image":"',image,
            '","attributes":[{"trait_type":"Day","value":',day,
            '},{"trait_type":"Total Days","value":40},{"trait_type":"Signal","value":"',title,
            '"},{"trait_type":"Network","value":"Arc Testnet"}]}'
        );
        return string.concat("data:application/json;base64,",MachinaBase64.encode(bytes(json)));
    }

    function setImageBaseUrl(string calldata newUrl) external onlyOwner {
        imageBaseUrl = newUrl;
        emit ImageBaseUrlChanged(newUrl);
        for (uint256 id = 1; id <= TOTAL_DAYS; id++) emit URI(this.uri(id),id);
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

    function _title(uint256 id) private pure returns(string memory){
        if(id==1)return "First Signal"; if(id==2)return "Boot Sequence"; if(id==3)return "Green Pulse"; if(id==4)return "Relay Online"; if(id==5)return "Vector Lock";
        if(id==6)return "Machine Heart"; if(id==7)return "Proof of Motion"; if(id==8)return "Route Found"; if(id==9)return "Channel Open"; if(id==10)return "Network Pulse";
        if(id==20)return "Threshold"; if(id==30)return "Final Approach"; if(id==40)return "Mainnet Ignition"; return string.concat("Signal ",_toString(id));
    }
    function _toString(uint256 value) private pure returns(string memory){ if(value==0)return "0"; uint256 temp=value; uint256 digits; while(temp!=0){digits++;temp/=10;} bytes memory buffer=new bytes(digits); while(value!=0){digits--;buffer[digits]=bytes1(uint8(48+uint256(value%10)));value/=10;} return string(buffer); }
    function _checkReceiver(address operator,address from,address to,uint256 id,uint256 amount,bytes memory data) private { if(to.code.length==0)return; try IERC1155Receiver(to).onERC1155Received(operator,from,id,amount,data) returns(bytes4 response){ require(response==IERC1155Receiver.onERC1155Received.selector,"Rejected"); } catch { revert("Unsafe receiver"); } }
    function _checkBatchReceiver(address operator,address from,address to,uint256[] calldata ids,uint256[] calldata amounts,bytes calldata data) private { if(to.code.length==0)return; try IERC1155Receiver(to).onERC1155BatchReceived(operator,from,ids,amounts,data) returns(bytes4 response){ require(response==IERC1155Receiver.onERC1155BatchReceived.selector,"Rejected"); } catch { revert("Unsafe receiver"); } }
}
