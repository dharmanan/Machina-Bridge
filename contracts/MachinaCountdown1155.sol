// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IERC1155Receiver is IERC165 {
    function onERC1155Received(address operator, address from, uint256 id, uint256 value, bytes calldata data) external returns (bytes4);
    function onERC1155BatchReceived(address operator, address from, uint256[] calldata ids, uint256[] calldata values, bytes calldata data) external returns (bytes4);
}

interface IERC1155 is IERC165 {
    event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value);
    event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values);
    event ApprovalForAll(address indexed account, address indexed operator, bool approved);
    event URI(string value, uint256 indexed id);

    function balanceOf(address account, uint256 id) external view returns (uint256);
    function balanceOfBatch(address[] calldata accounts, uint256[] calldata ids) external view returns (uint256[] memory);
    function setApprovalForAll(address operator, bool approved) external;
    function isApprovedForAll(address account, address operator) external view returns (bool);
    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external;
    function safeBatchTransferFrom(address from, address to, uint256[] calldata ids, uint256[] calldata amounts, bytes calldata data) external;
}

interface IERC1155MetadataURI is IERC1155 {
    function uri(uint256 id) external view returns (string memory);
}

library MachinaBase64 {
    bytes internal constant TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    function encode(bytes memory data) internal pure returns (string memory) {
        if (data.length == 0) return "";

        uint256 encodedLength = 4 * ((data.length + 2) / 3);
        bytes memory result = new bytes(encodedLength);
        uint256 inputIndex;
        uint256 outputIndex;

        while (inputIndex < data.length) {
            uint256 a = uint8(data[inputIndex++]);
            uint256 b = inputIndex < data.length ? uint8(data[inputIndex++]) : 0;
            uint256 c = inputIndex < data.length ? uint8(data[inputIndex++]) : 0;
            uint256 chunk = (a << 16) | (b << 8) | c;

            result[outputIndex++] = TABLE[(chunk >> 18) & 0x3F];
            result[outputIndex++] = TABLE[(chunk >> 12) & 0x3F];
            result[outputIndex++] = TABLE[(chunk >> 6) & 0x3F];
            result[outputIndex++] = TABLE[chunk & 0x3F];
        }

        uint256 remainder = data.length % 3;
        if (remainder == 1) {
            result[encodedLength - 1] = "=";
            result[encodedLength - 2] = "=";
        } else if (remainder == 2) {
            result[encodedLength - 1] = "=";
        }

        return string(result);
    }
}

contract MachinaCountdown1155 is IERC1155MetadataURI {
    uint8 public constant TOTAL_DAYS = 40;
    uint8 public constant METADATA_VERSION = 3;
    string public constant name = "Arc Mainnet Countdown";
    string public constant symbol = "ARC40";

    address public owner;
    uint64 public immutable startTime;
    bool public immutable testMode;
    uint8 public testDay;
    uint256 public totalSupply;

    mapping(uint256 => mapping(address => uint256)) private balances;
    mapping(address => mapping(address => bool)) private operatorApprovals;
    mapping(address => uint256) public claimedBitmap;
    mapping(address => uint8) public claimedCount;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event DailyClaim(address indexed wallet, uint8 indexed day, uint256 indexed tokenId);
    event TestDayChanged(uint8 indexed day);
    event SmokeDayReset(address indexed wallet, uint8 indexed day);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(uint64 campaignStartTime, bool enableTestMode) {
        owner = msg.sender;
        startTime = campaignStartTime;
        testMode = enableTestMode;
        if (enableTestMode) testDay = 1;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0xd9b67a26 || interfaceId == 0x0e89341c;
    }

    function contractURI() external pure returns (string memory) {
        string memory json = string.concat(
            '{"name":"Arc Mainnet Countdown","description":"Independent Machina community countdown to Arc Mainnet. Collect one daily participation NFT and build a 40-day wallet record.",',
            '"image":"', _collectionImage(), '"}'
        );
        return string.concat("data:application/json;base64,", MachinaBase64.encode(bytes(json)));
    }

    function uri(uint256 id) external pure override returns (string memory) {
        require(id >= 1 && id <= TOTAL_DAYS, "Invalid token id");
        string memory day = _toString(id);
        string memory paddedDay = id < 10 ? string.concat("0", day) : day;
        string memory title = _title(id);
        string memory svg = _tokenSvg(id, paddedDay, title);
        string memory image = string.concat("data:image/svg+xml;base64,", MachinaBase64.encode(bytes(svg)));
        string memory json = string.concat(
            '{"name":"Arc Mainnet Countdown - Day ', paddedDay,
            '","description":"Day ', day,
            ' of the 40-day Arc Mainnet countdown. This NFT records participation by the holder wallet.","image":"', image,
            '","attributes":[{"trait_type":"Day","value":', day,
            '},{"trait_type":"Total Days","value":40},{"trait_type":"Signal","value":"', title,
            '"},{"trait_type":"Network","value":"Arc Testnet"}]}'
        );
        return string.concat("data:application/json;base64,", MachinaBase64.encode(bytes(json)));
    }

    function balanceOf(address account, uint256 id) public view override returns (uint256) {
        require(account != address(0), "Zero address");
        return balances[id][account];
    }

    function balanceOfBatch(address[] calldata accounts, uint256[] calldata ids) external view override returns (uint256[] memory result) {
        require(accounts.length == ids.length, "Length mismatch");
        result = new uint256[](accounts.length);
        for (uint256 i = 0; i < accounts.length; i++) result[i] = balanceOf(accounts[i], ids[i]);
    }

    function setApprovalForAll(address operator, bool approved) external override {
        require(operator != msg.sender, "Self approval");
        operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address account, address operator) public view override returns (bool) {
        return operatorApprovals[account][operator];
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external override {
        require(from == msg.sender || isApprovedForAll(from, msg.sender), "Not approved");
        _transfer(from, to, id, amount, data);
    }

    function safeBatchTransferFrom(address from, address to, uint256[] calldata ids, uint256[] calldata amounts, bytes calldata data) external override {
        require(from == msg.sender || isApprovedForAll(from, msg.sender), "Not approved");
        require(ids.length == amounts.length, "Length mismatch");
        require(to != address(0), "Zero address");
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 fromBalance = balances[ids[i]][from];
            require(fromBalance >= amounts[i], "Insufficient balance");
            balances[ids[i]][from] = fromBalance - amounts[i];
            balances[ids[i]][to] += amounts[i];
        }
        emit TransferBatch(msg.sender, from, to, ids, amounts);
        _checkBatchReceiver(msg.sender, from, to, ids, amounts, data);
    }

    function currentDay() public view returns (uint8) {
        if (testMode && testDay != 0) return testDay;
        if (block.timestamp < startTime) return 0;
        uint256 elapsedDays = (block.timestamp - startTime) / 1 days;
        if (elapsedDays >= TOTAL_DAYS) return TOTAL_DAYS + 1;
        return uint8(elapsedDays + 1);
    }

    function hasClaimed(address wallet, uint8 day) public view returns (bool) {
        if (day == 0 || day > TOTAL_DAYS) return false;
        return (claimedBitmap[wallet] & (uint256(1) << (day - 1))) != 0;
    }

    function claim() external {
        uint8 day = currentDay();
        require(day >= 1 && day <= TOTAL_DAYS, "Claim window closed");
        require(!hasClaimed(msg.sender, day), "Already claimed");
        claimedBitmap[msg.sender] |= uint256(1) << (day - 1);
        claimedCount[msg.sender] += 1;
        _mint(msg.sender, uint256(day), 1, "");
        emit DailyClaim(msg.sender, day, uint256(day));
    }

    function eligibilityTier(address wallet) external view returns (uint8) {
        uint8 count = claimedCount[wallet];
        if (count >= 40) return 40;
        if (count >= 30) return 30;
        if (count >= 20) return 20;
        return 0;
    }

    function claimedDays(address wallet) external view returns (uint8[] memory dayList) {
        uint8 count = claimedCount[wallet];
        dayList = new uint8[](count);
        uint256 cursor;
        for (uint8 day = 1; day <= TOTAL_DAYS; day++) {
            if (hasClaimed(wallet, day)) dayList[cursor++] = day;
        }
    }

    function setTestDay(uint8 day) external onlyOwner {
        require(testMode, "Test mode disabled");
        require(day >= 1 && day <= TOTAL_DAYS, "Invalid day");
        testDay = day;
        emit TestDayChanged(day);
    }

    function resetSmokeDay(address wallet, uint8 day) external onlyOwner {
        require(testMode, "Test mode disabled");
        require(day >= 1 && day <= TOTAL_DAYS, "Invalid day");
        require(hasClaimed(wallet, day), "Day not claimed");
        claimedBitmap[wallet] &= ~(uint256(1) << (day - 1));
        claimedCount[wallet] -= 1;
        _burn(wallet, uint256(day), 1);
        emit SmokeDayReset(wallet, day);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function _mint(address to, uint256 id, uint256 amount, bytes memory data) internal {
        require(to != address(0), "Zero address");
        balances[id][to] += amount;
        totalSupply += amount;
        emit TransferSingle(msg.sender, address(0), to, id, amount);
        emit URI(this.uri(id), id);
        _checkReceiver(msg.sender, address(0), to, id, amount, data);
    }

    function _burn(address from, uint256 id, uint256 amount) internal {
        uint256 fromBalance = balances[id][from];
        require(fromBalance >= amount, "Insufficient balance");
        balances[id][from] = fromBalance - amount;
        totalSupply -= amount;
        emit TransferSingle(msg.sender, from, address(0), id, amount);
    }

    function _transfer(address from, address to, uint256 id, uint256 amount, bytes memory data) internal {
        require(to != address(0), "Zero address");
        uint256 fromBalance = balances[id][from];
        require(fromBalance >= amount, "Insufficient balance");
        balances[id][from] = fromBalance - amount;
        balances[id][to] += amount;
        emit TransferSingle(msg.sender, from, to, id, amount);
        _checkReceiver(msg.sender, from, to, id, amount, data);
    }

    function _collectionImage() private pure returns (string memory) {
        string memory svg = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800"><rect width="800" height="800" rx="70" fill="rgb(4,10,7)"/><circle cx="400" cy="390" r="230" fill="none" stroke="rgb(45,60,50)" stroke-width="18" stroke-dasharray="18 12"/><circle cx="400" cy="390" r="155" fill="rgb(1,5,3)" stroke="rgb(73,205,35)" stroke-width="4"/><path d="M400 245 L535 485 L265 485 Z" fill="none" stroke="rgb(73,205,35)" stroke-width="8"/><circle cx="400" cy="365" r="78" fill="rgb(230,238,232)"/><circle cx="428" cy="350" r="22" fill="rgb(83,145,58)"/><path d="M348 330 Q390 270 442 322 L450 415 Q407 455 357 414 Z" fill="rgb(245,248,246)" stroke="rgb(95,132,103)" stroke-width="5"/><text x="400" y="675" text-anchor="middle" fill="white" font-family="Arial,sans-serif" font-size="48" font-weight="700">ARC MAINNET COUNTDOWN</text></svg>';
        return string.concat("data:image/svg+xml;base64,", MachinaBase64.encode(bytes(svg)));
    }

    function _tokenSvg(uint256 id, string memory paddedDay, string memory title) private pure returns (string memory) {
        uint256 progress = 40 + (id * 12);
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1100" viewBox="0 0 800 1100">',
            '<defs><pattern id="n" width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.7" fill="rgb(38,54,44)"/></pattern><filter id="g"><feGaussianBlur stdDeviation="8"/></filter></defs>',
            '<rect width="800" height="1100" rx="42" fill="rgb(3,8,5)"/><rect x="18" y="18" width="764" height="1064" rx="34" fill="url(#n)" stroke="rgb(94,108,99)" stroke-width="4"/>',
            '<text x="62" y="82" fill="rgb(126,240,73)" font-family="Arial,sans-serif" font-size="22" font-weight="700" letter-spacing="6">ARC MAINNET COUNTDOWN</text>',
            '<text x="64" y="142" fill="rgb(198,210,202)" font-family="Arial,sans-serif" font-size="24" letter-spacing="5">DAY</text>',
            '<text x="62" y="235" fill="white" font-family="Arial,sans-serif" font-size="98" font-weight="300">', paddedDay, '</text>',
            '<text x="64" y="282" fill="rgb(198,210,202)" font-family="Arial,sans-serif" font-size="34">/ 40</text>',
            '<circle cx="400" cy="515" r="228" fill="none" stroke="rgb(41,52,45)" stroke-width="22" stroke-dasharray="18 14"/>',
            '<circle cx="400" cy="515" r="228" fill="none" stroke="rgb(111,239,54)" stroke-width="17" pathLength="520" stroke-dasharray="', _toString(progress), ' 520" transform="rotate(-90 400 515)" filter="url(#g)" opacity="0.52"/>',
            '<circle cx="400" cy="515" r="150" fill="rgb(1,5,3)" stroke="rgb(54,89,64)" stroke-width="3"/><path d="M400 382 L525 620 L275 620 Z" fill="none" stroke="rgb(73,205,35)" stroke-width="6"/>',
            '<path d="M345 455 Q390 394 451 442 L459 555 Q411 602 355 558 Z" fill="rgb(241,246,243)" stroke="rgb(88,127,96)" stroke-width="5"/><path d="M362 463 Q395 445 430 455" fill="none" stroke="rgb(61,118,66)" stroke-width="6"/><circle cx="448" cy="489" r="29" fill="rgb(59,116,61)" stroke="rgb(178,204,184)" stroke-width="7"/><circle cx="448" cy="489" r="10" fill="rgb(11,40,22)"/>',
            '<line x1="64" y1="775" x2="736" y2="775" stroke="rgb(35,49,40)" stroke-width="2"/><text x="400" y="855" text-anchor="middle" fill="white" font-family="Arial,sans-serif" font-size="44" font-weight="700">', _upper(title), '</text>',
            '<text x="400" y="916" text-anchor="middle" fill="rgb(156,174,162)" font-family="Arial,sans-serif" font-size="25">Day ', _toString(id), ' of 40</text>',
            '<rect x="62" y="1010" width="676" height="3" fill="rgb(36,48,40)"/><text x="64" y="1052" fill="rgb(118,238,64)" font-family="Arial,sans-serif" font-size="18" letter-spacing="4">MACHINA</text>',
            '</svg>'
        );
    }

    function _title(uint256 id) private pure returns (string memory) {
        if (id == 1) return "First Signal";
        if (id == 2) return "Boot Sequence";
        if (id == 3) return "Green Pulse";
        if (id == 4) return "Relay Online";
        if (id == 5) return "Vector Lock";
        if (id == 6) return "Machine Heart";
        if (id == 7) return "Proof of Motion";
        if (id == 8) return "Route Found";
        if (id == 9) return "Channel Open";
        if (id == 10) return "Network Pulse";
        if (id == 20) return "Threshold";
        if (id == 30) return "Final Approach";
        if (id == 40) return "Mainnet Ignition";
        return string.concat("Signal ", _toString(id));
    }

    function _upper(string memory value) private pure returns (string memory) {
        bytes memory source = bytes(value);
        for (uint256 i = 0; i < source.length; i++) {
            uint8 charCode = uint8(source[i]);
            if (charCode >= 97 && charCode <= 122) source[i] = bytes1(charCode - 32);
        }
        return string(source);
    }

    function _toString(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) { digits++; temp /= 10; }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }

    function _checkReceiver(address operator, address from, address to, uint256 id, uint256 amount, bytes memory data) private {
        if (to.code.length == 0) return;
        try IERC1155Receiver(to).onERC1155Received(operator, from, id, amount, data) returns (bytes4 response) {
            require(response == IERC1155Receiver.onERC1155Received.selector, "Rejected");
        } catch { revert("Unsafe receiver"); }
    }

    function _checkBatchReceiver(address operator, address from, address to, uint256[] calldata ids, uint256[] calldata amounts, bytes calldata data) private {
        if (to.code.length == 0) return;
        try IERC1155Receiver(to).onERC1155BatchReceived(operator, from, ids, amounts, data) returns (bytes4 response) {
            require(response == IERC1155Receiver.onERC1155BatchReceived.selector, "Rejected");
        } catch { revert("Unsafe receiver"); }
    }
}
